import { AxiError } from "axi-sdk-js";
import { boolFlag, parseArgs, stringFlag, stringFlags } from "../args.js";
import { bitbucketResponse, type Json } from "../client.js";
import type { RepoContext } from "../context.js";
import {
  assertPrDescriptionReadback,
  isPullRequestDescriptionPath,
  pullRequestDescriptionReadbackPath,
  readPrBodyFile,
  validatePrDescription,
} from "../pr-body.js";
import { expandApiPath, parseApiFields, parseUploads, scalar, truncateJson } from "./utils.js";

export const API_HELP = `usage: bitbucket-axi api [<method>] <path> [flags]
description: Make an authenticated Bitbucket Cloud REST API v2.0 request.
methods[6]:
  GET, POST, PUT, PATCH, DELETE, HEAD
flags[5]:
  --field <key=value> (repeatable, JSON body or GET query), --body-file <path> (PR-description writes only), --file <form-field>=<local path> (repeatable, sends multipart/form-data), --full, -R/--repo <workspace/repo>
examples[4]:
  bitbucket-axi api /repositories/{workspace}/{repo}
  bitbucket-axi api GET /user
  bitbucket-axi api GET /repositories/{workspace}/{repo}/refs/branches --field pagelen=10
  bitbucket-axi api POST /repositories/{workspace}/{repo}/downloads --file files=./screenshot.png
notes[5]:
  Image bytes are sent unchanged; use a distinct file name per image because re-uploading a name replaces it. An upload replies with no body, so the status appears as http_status.
  An upload never edits a pull request; patch the description that references the file separately.
  A pull request description is checked before it is sent: every Downloads image it references must exist under its exact URL name and hold a non-empty image, and a missing file stops the write.
  Reference an uploaded image from PR markdown as https://bitbucket.org/{workspace}/{repo}/downloads/<name>
  --body-file sends one UTF-8 Markdown file as the PR description and cannot be combined with --field description=... or --file. Serialized {description: ...} envelopes are rejected, and a successful write is read back for exact equality.
`;

export async function apiCommand(args: string[], ctx?: RepoContext): Promise<Record<string, Json>> {
  const parsed = parseArgs(
    args,
    [
      { name: "--field", repeatable: true },
      { name: "--body-file" },
      { name: "--file", repeatable: true },
      { name: "--full", boolean: true },
    ],
    "bitbucket-axi api",
  );
  const positionals = [...parsed.positionals];
  const first = positionals[0]?.toUpperCase();
  const methods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
  const method = first && methods.has(first) ? positionals.shift()!.toUpperCase() : "GET";
  if (positionals.length !== 1)
    throw new AxiError("api requires exactly one relative path", "VALIDATION_ERROR", [
      "Run `bitbucket-axi api --help`",
    ]);
  const path = expandApiPath(positionals[0]!, ctx);
  const fields = parseApiFields(stringFlags(parsed, "--field"));
  const bodyFile = stringFlag(parsed, "--body-file");
  const files = parseUploads(stringFlags(parsed, "--file"));
  const readOnly = method === "GET" || method === "HEAD";
  if (bodyFile !== undefined && !["POST", "PUT", "PATCH"].includes(method))
    throw new AxiError("--body-file requires POST, PUT, or PATCH", "VALIDATION_ERROR", [
      "Use --body-file only to write a pull request description",
    ]);
  if (bodyFile !== undefined && !isPullRequestDescriptionPath(path))
    throw new AxiError("--body-file only applies to a pull request description write", "VALIDATION_ERROR", [
      "Use a POST, PUT, or PATCH path ending in `/pullrequests` or `/pullrequests/<id>`",
      "The request was not sent",
    ]);
  if (bodyFile !== undefined && Object.hasOwn(fields, "description"))
    throw new AxiError("--body-file and --field description cannot be combined", "VALIDATION_ERROR", [
      "Choose one source for the pull request description",
      "The description was not sent",
    ]);
  if (bodyFile !== undefined && files.length)
    throw new AxiError("--body-file cannot be combined with --file", "VALIDATION_ERROR", [
      "A body file supplies the PR description; it is not a multipart upload",
      "The request was not sent",
    ]);
  if (bodyFile !== undefined) fields["description"] = readPrBodyFile(bodyFile);
  if (files.length && readOnly)
    throw new AxiError("--file requires POST, PUT, or PATCH", "VALIDATION_ERROR", [
      "Uploads are multipart/form-data request bodies; pick a write method",
    ]);
  if (files.length && Object.keys(fields).length)
    throw new AxiError("--file cannot be combined with --field", "VALIDATION_ERROR", [
      "Send upload parts only; multipart form fields alongside files are not supported",
    ]);
  const query = readOnly
    ? Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, scalar(value)]))
    : undefined;
  // The raw API is the documented way to write a PR body, so it carries the same
  // envelope and image checks as `pr create` before the mutation is sent.
  const writesDescription =
    ["POST", "PUT", "PATCH"].includes(method) &&
    isPullRequestDescriptionPath(path) &&
    fields["description"] !== undefined;
  const intendedDescription = writesDescription
    ? await validatePrDescription(fields["description"]!)
    : undefined;
  const response = await bitbucketResponse(path, {
    method,
    ...(query ? { query } : {}),
    ...(files.length ? { files } : query ? {} : { body: fields }),
  });
  if (intendedDescription !== undefined) {
    await assertPrDescriptionReadback(
      pullRequestDescriptionReadbackPath(path, response.payload),
      intendedDescription,
    );
  }
  const full = boolFlag(parsed, "--full");
  const truncated = truncateJson(response.payload, full);
  return {
    // A response with no body (a downloads upload, a 204 delete) leaves the
    // status as the only evidence the request succeeded.
    ...(response.payload === null ? { http_status: response.status } : {}),
    api_response: truncated.value,
    ...(truncated.changed ? { help: ["Run the same command with `--full` for complete string values"] } : {}),
  };
}
