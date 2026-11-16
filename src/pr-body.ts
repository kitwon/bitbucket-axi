import { readFileSync } from "node:fs";
import { AxiError } from "axi-sdk-js";
import {
  bitbucketFile,
  bitbucketRequest,
  isObject,
  type Json,
  type StoredFile,
} from "./client.js";

// A pull request description is written as a single API mutation, so a broken
// image reference reaches every reader at once. The observed failure is a body
// whose URL names a different file than the one uploaded: the Markdown is valid,
// the image is a permanent 404. Everything a description references under a
// repository's Downloads is therefore verified before the mutation is sent.

export interface DownloadReference {
  workspace: string;
  repo: string;
  name: string;
}

export interface BodyImages {
  references: DownloadReference[];
  problems: string[];
}

const IMAGE_RE = /!\[([^\]\n]*)\]\(\s*(<[^>\n]*>|[^)\n]*?)\s*\)/g;
const UNTERMINATED_IMAGE_RE = /!\[[^\]\n]*\]\([^)\n]*$/gm;
const DOWNLOAD_URL_RE =
  /^https:\/\/bitbucket\.org\/([^/\s?#]+)\/([^/\s?#]+)\/downloads\/([^/\s?#]+)$/i;
// A stored object served as text is not a screenshot, and an HTML error page can
// answer 200. A binary type (image/png, but also application/octet-stream when a
// stored upload carries no type) is accepted; the bytes prove it is not empty.
const TEXTUAL_TYPE_RE = /^(?:text\/|application\/(?:json|xml|xhtml\+xml))/i;

// Paths whose mutation writes the pull request body itself.
const PR_BODY_PATH_RE = /^(?:2\.0\/)?repositories\/[^/]+\/[^/]+\/pullrequests(?:\/\d+)?\/?$/;
const PR_ITEM_PATH_RE = /^(?:2\.0\/)?repositories\/[^/]+\/[^/]+\/pullrequests\/\d+$/;
const SERIALIZED_DESCRIPTION_RE = /^(['"])description\1\s*:\s*([\s\S]+)$/;

export function isPullRequestDescriptionPath(path: string): boolean {
  return PR_BODY_PATH_RE.test(path.replace(/^\/+/, ""));
}

// A caller that accidentally serializes a whole field object sends a complete
// one-key envelope instead of Markdown. Only the whole value is rejected, so
// prose and fenced examples that merely mention this shape stay valid.
export function isSerializedDescriptionEnvelope(value: Json): boolean {
  if (isObject(value)) {
    const keys = Object.keys(value);
    return keys.length === 1 && keys[0] === "description" && typeof value["description"] === "string";
  }
  if (typeof value !== "string") return false;

  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
  const match = SERIALIZED_DESCRIPTION_RE.exec(trimmed.slice(1, -1).trim());
  return match !== null && isQuotedString(match[2]!.trim());
}

// Fail before any request when the value is an envelope or is not text, then
// retain the existing Downloads image checks for genuine Markdown.
export async function validatePrDescription(description: Json): Promise<string> {
  if (isSerializedDescriptionEnvelope(description)) {
    throw new AxiError(
      "pull request description is a serialized {description: ...} envelope",
      "VALIDATION_ERROR",
      [
        "Pass the raw Markdown itself, not a printed or serialized description object",
        "Use `--body-file <path>` on `pr create` or a raw PR-description `api` write so the file is sent unchanged",
        "The description was not sent",
      ],
    );
  }
  if (typeof description !== "string") {
    throw new AxiError("pull request description must be plain Markdown text", "VALIDATION_ERROR", [
      "Send the Markdown string itself, or use `--body-file <path>`",
      "The description was not sent",
    ]);
  }

  await assertPrBodyImages(description);
  return description;
}

// Reads a body file as exact UTF-8 text. JSON transport escapes control
// characters, but parsing the JSON restores the original characters and
// trailing newlines; no trim or platform-specific newline conversion is done.
export function readPrBodyFile(path: string): string {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    throw new AxiError(`cannot read --body-file: ${path}`, "VALIDATION_ERROR", [
      "Pass a readable UTF-8 file path",
      "The description was not sent",
    ]);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new AxiError(`--body-file is not valid UTF-8: ${path}`, "VALIDATION_ERROR", [
      "Save the Markdown as UTF-8 and retry",
      "The description was not sent",
    ]);
  }
}

// For a collection POST, Bitbucket's response id names the new PR. Item writes
// already contain their id. The caller then GETs this exact resource.
export function pullRequestDescriptionReadbackPath(path: string, payload: Json): string {
  const normalized = path.replace(/^\/+/, "").replace(/\/+$/, "");
  if (PR_ITEM_PATH_RE.test(normalized)) return normalized;

  if (
    isObject(payload) &&
    typeof payload["id"] === "number" &&
    Number.isInteger(payload["id"]) &&
    payload["id"] > 0
  ) {
    return `${normalized}/${payload["id"]}`;
  }
  throw new AxiError(
    "Bitbucket created the pull request but did not return its id",
    "API_ERROR",
    [
      "The description write succeeded; inspect the repository for the new pull request before retrying",
      "The saved description could not be verified, so no retry or rollback was attempted",
    ],
  );
}

// A successful mutation is not proof of what was stored. Read the raw field
// from the resource and require exact equality; never retry or roll back here,
// because another actor may have written a newer description after our write.
export async function assertPrDescriptionReadback(
  path: string,
  expected: string,
): Promise<void> {
  let raw: Json;
  try {
    raw = await bitbucketRequest(path);
  } catch (error) {
    const detail = error instanceof Error && error.message ? `: ${error.message}` : "";
    throw new AxiError(
      `could not verify the saved pull request description${detail}`,
      "API_ERROR",
      [
        "The description write succeeded, but reading it back failed",
        "Inspect the pull request before retrying; a retry can overwrite a newer edit",
        "No retry or rollback was attempted",
      ],
    );
  }

  const saved = isObject(raw) && typeof raw["description"] === "string"
    ? raw["description"]
    : undefined;
  if (saved === expected) return;

  const savedSummary = saved === undefined
    ? "Bitbucket returned no raw description"
    : `saved ${saved.length} characters / ${Buffer.byteLength(saved, "utf8")} bytes`;
  throw new AxiError(
    "Bitbucket saved a different pull request description",
    "API_ERROR",
    [
      `Expected ${expected.length} characters / ${Buffer.byteLength(expected, "utf8")} bytes; ${savedSummary}`,
      "Inspect the saved description with `bitbucket-axi pr view <id> --full` before making another change",
      "The saved text was left untouched; no retry or rollback was attempted because another edit may have arrived",
    ],
  );
}

// Fails closed before the request: every referenced Downloads file must exist
// under the exact name in the URL and hold a non-empty, non-text body.
export async function assertPrBodyImages(description: string): Promise<void> {
  const { references, problems } = parseBodyImages(description);
  if (problems.length) {
    throw new AxiError("pull request body has invalid image syntax", "VALIDATION_ERROR", [
      ...problems,
      "The description was not sent",
    ]);
  }
  if (!references.length) return;

  const failures: string[] = [];
  const failed: DownloadReference[] = [];
  for (const reference of references) {
    const reason = await checkReference(reference);
    if (!reason) continue;
    failures.push(`downloads/${reference.name} in ${reference.workspace}/${reference.repo} ${reason}`);
    failed.push(reference);
  }
  if (!failures.length) return;

  const count = failures.length;
  throw new AxiError(
    `${count} image reference${count === 1 ? "" : "s"} in the pull request body cannot be published`,
    "VALIDATION_ERROR",
    [
      ...failures,
      ...failed.map(
        (reference) =>
          `Upload the file under its exact body name first: \`bitbucket-axi api POST /repositories/${reference.workspace}/${reference.repo}/downloads --file files=<dir>/${reference.name}\``,
      ),
      "The description was not sent; no image upload is started for you",
    ],
  );
}

// Extracts the expandable image references and the syntax faults that would
// silently drop or split an image. Code spans are skipped because Markdown
// renders them literally rather than as images.
export function parseBodyImages(description: string): BodyImages {
  const visible = stripCode(description);
  const problems: string[] = [];
  for (const match of visible.matchAll(UNTERMINATED_IMAGE_RE)) {
    problems.push(`line ${lineAt(visible, match.index)}: image has no closing ")"`);
  }

  const references: DownloadReference[] = [];
  const seen = new Set<string>();
  for (const match of visible.matchAll(IMAGE_RE)) {
    const line = lineAt(visible, match.index);
    const alt = match[1] ?? "";
    const raw = match[2] ?? "";
    const destination = raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw;
    if (!destination) {
      problems.push(`line ${line}: image has an empty destination`);
      continue;
    }
    if (isTableRow(visible, match.index) && /(^|[^\\])\|/.test(alt)) {
      problems.push(
        `line ${line}: image alt text holds an unescaped "|" in a table row; write "\\|" or the pipe splits the cell`,
      );
    }
    const parsed = parseDownloadUrl(destination);
    if (!parsed) continue;
    if (typeof parsed === "string") {
      problems.push(`line ${line}: ${parsed}`);
      continue;
    }
    const key = `${parsed.workspace}/${parsed.repo}/${parsed.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    references.push(parsed);
  }
  return { references, problems };
}

async function checkReference(reference: DownloadReference): Promise<string | null> {
  const path = `repositories/${encodeURIComponent(reference.workspace)}/${encodeURIComponent(reference.repo)}/downloads/${encodeURIComponent(reference.name)}`;
  let file: StoredFile;
  try {
    file = await bitbucketFile(path);
  } catch (error) {
    if (error instanceof AxiError) {
      if (error.code === "NOT_FOUND") return "does not exist";
      return `could not be read: ${error.message}`;
    }
    throw error;
  }
  if (file.size === 0) return "is an empty file";
  if (TEXTUAL_TYPE_RE.test(file.contentType)) return `is ${file.contentType}, not an image`;
  return null;
}

// Returns a reference, or a problem message when the URL looks like a Downloads
// file but cannot name one exactly.
function parseDownloadUrl(destination: string): DownloadReference | undefined | string {
  const match = destination.match(DOWNLOAD_URL_RE);
  if (!match) return undefined;
  let name: string;
  try {
    name = decodeURIComponent(match[3]!);
  } catch {
    return `image file name is not valid percent-encoding: ${match[3]!}`;
  }
  // Downloads reads accept glob patterns, so a pattern in a body URL would pass
  // a presence check while showing a broken image in a browser.
  if (/[*?\\]/.test(name)) return `image file name must be literal, without * or ?: ${name}`;
  return { workspace: match[1]!, repo: match[2]!, name };
}

function stripCode(description: string): string {
  return description
    .replace(/^```[\s\S]*?^```/gm, "")
    .replace(/`[^`\n]*`/g, "");
}

function lineAt(value: string, index: number): number {
  return value.slice(0, index).split("\n").length;
}

function isTableRow(value: string, index: number): boolean {
  const start = value.lastIndexOf("\n", index - 1) + 1;
  const end = value.indexOf("\n", index);
  const line = value.slice(start, end === -1 ? undefined : end);
  return line.trim().startsWith("|");
}

function isQuotedString(value: string): boolean {
  const quote = value[0];
  if (quote !== "'" && quote !== '"') return false;
  for (let index = 1; index < value.length; index++) {
    const character = value[index];
    if (character === "\\") {
      index++;
      continue;
    }
    if (character !== quote) continue;
    const rest = value.slice(index + 1).trim();
    return rest === "" || rest === ",";
  }
  return false;
}
