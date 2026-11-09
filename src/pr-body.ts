import { AxiError } from "axi-sdk-js";
import { bitbucketFile, type StoredFile } from "./client.js";

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

export function isPullRequestDescriptionPath(path: string): boolean {
  return PR_BODY_PATH_RE.test(path.replace(/^\/+/, ""));
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
