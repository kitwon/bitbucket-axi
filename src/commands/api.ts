import { AxiError } from "axi-sdk-js";
import { boolFlag, parseArgs, stringFlags } from "../args.js";
import { bitbucketResponse, type Json } from "../client.js";
import type { RepoContext } from "../context.js";
import { expandApiPath, parseApiFields, parseUploads, scalar, truncateJson } from "./utils.js";

export const API_HELP = `usage: bitbucket-axi api [<method>] <path> [flags]
description: Make an authenticated Bitbucket Cloud REST API v2.0 request.
methods[6]:
  GET, POST, PUT, PATCH, DELETE, HEAD
flags[4]:
  --field <key=value> (repeatable, JSON body or GET query), --file <form-field>=<local path> (repeatable, sends multipart/form-data), --full, -R/--repo <workspace/repo>
examples[4]:
  bitbucket-axi api /repositories/{workspace}/{repo}
  bitbucket-axi api GET /user
  bitbucket-axi api GET /repositories/{workspace}/{repo}/refs/branches --field pagelen=10
  bitbucket-axi api POST /repositories/{workspace}/{repo}/downloads --file files=./screenshot.png
notes[3]:
  Image bytes are sent unchanged; use a distinct file name per image because re-uploading a name replaces it. An upload replies with no body, so the status appears as http_status.
  An upload never edits a pull request; patch the description that references the file separately.
  Reference an uploaded image from PR markdown as https://bitbucket.org/{workspace}/{repo}/downloads/<name>
`;

export async function apiCommand(args: string[], ctx?: RepoContext): Promise<Record<string, Json>> {
  const parsed = parseArgs(
    args,
    [
      { name: "--field", repeatable: true },
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
  const files = parseUploads(stringFlags(parsed, "--file"));
  const readOnly = method === "GET" || method === "HEAD";
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
  const response = await bitbucketResponse(path, {
    method,
    ...(query ? { query } : {}),
    ...(files.length ? { files } : query ? {} : { body: fields }),
  });
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
