import { AxiError } from "axi-sdk-js";
import { stringFlag, type ParsedArgs } from "../args.js";
import { isObject, type FileUpload, type Json, type JsonObject } from "../client.js";
import type { RepoContext } from "../context.js";

// Shared helpers extracted from the original monolithic commands module. Each
// domain command imports only what it needs from here.

export function prListRow(raw: JsonObject, extras: string[]): JsonObject {
  const row: JsonObject = compact({
    id: number(raw, "id"),
    title: text(raw, "title"),
    state: text(raw, "state").toLowerCase(),
    author: actor(raw["author"]),
  });
  for (const extra of extras) {
    if (extra === "source") row[extra] = branch(raw, "source");
    if (extra === "destination") row[extra] = branch(raw, "destination");
    if (extra === "created") row[extra] = text(raw, "created_on");
    if (extra === "url") row[extra] = nestedText(raw, "links", "html", "href");
    if (extra === "draft") row[extra] = raw["draft"] === true ? "yes" : "no";
    if (extra === "comments") row[extra] = number(raw, "comment_count") ?? 0;
  }
  return row;
}

export function pipelineListRow(raw: JsonObject, extras: string[]): JsonObject {
  const row: JsonObject = compact({
    uuid: text(raw, "uuid"),
    build: number(raw, "build_number"),
    state: pipelineState(raw),
    branch: nestedText(raw, "target", "ref_name") || "none",
  });
  for (const extra of extras) {
    if (extra === "creator") row[extra] = actor(raw["creator"]);
    if (extra === "created") row[extra] = text(raw, "created_on");
    if (extra === "commit") row[extra] = nestedText(raw, "target", "commit", "hash").slice(0, 12);
    if (extra === "completed") row[extra] = text(raw, "completed_on") || "pending";
    if (extra === "duration") row[extra] = number(raw, "duration_in_seconds") ?? 0;
    if (extra === "url") row[extra] = nestedText(raw, "links", "html", "href");
  }
  return row;
}

export function pipelineDetail(raw: JsonObject): JsonObject {
  return compact({
    uuid: text(raw, "uuid"),
    build: number(raw, "build_number"),
    state: pipelineState(raw),
    branch: nestedText(raw, "target", "ref_name") || "none",
    commit: nestedText(raw, "target", "commit", "hash").slice(0, 12) || "none",
    creator: actor(raw["creator"]),
    created: text(raw, "created_on"),
    completed: text(raw, "completed_on") || "pending",
    duration_seconds: number(raw, "duration_in_seconds") ?? 0,
    url: nestedText(raw, "links", "html", "href"),
  });
}

export function pipelineState(raw: JsonObject): string {
  return (
    nestedText(raw, "state", "result", "name") ||
    nestedText(raw, "state", "name") ||
    "unknown"
  ).toLowerCase();
}

export function repoPath(ctx: RepoContext): string {
  return `repositories/${encodeURIComponent(ctx.workspace)}/${encodeURIComponent(ctx.repo)}`;
}

export function requireRepo(ctx?: RepoContext): RepoContext {
  if (ctx) return ctx;
  throw new AxiError("no Bitbucket repository selected", "VALIDATION_ERROR", [
    "Run inside a repository with a bitbucket.org git remote or pass `-R <workspace/repo>`",
  ]);
}

export function repoHint(ctx: RepoContext): string {
  return ctx.source === "flag" ? ` -R ${ctx.nwo}` : "";
}

// Drill-in hint for a dashboard preview list. Reveals the true total when the
// preview is truncated so the agent does not mistake the page size for the count.
export function drillHint(command: string, noun: string, shown: number, total: number | undefined, ctx: RepoContext): string {
  const base = `Run \`bitbucket-axi ${command}${repoHint(ctx)}\``;
  return total !== undefined && total > shown ? `${base} for all ${total} ${noun}` : base;
}

export function parseFields(value: string | undefined, allowed: Set<string>, command: string): string[] {
  if (!value) return [];
  const fields = value.split(",").map((field) => field.trim()).filter(Boolean);
  const invalid = fields.filter((field) => !allowed.has(field));
  if (invalid.length)
    throw new AxiError(`unknown --fields value: ${invalid.join(",")}`, "VALIDATION_ERROR", [
      `Valid fields for ${command}: ${[...allowed].join(",")}`,
    ]);
  return [...new Set(fields)];
}

export function parseApiFields(values: string[]): JsonObject {
  const result: JsonObject = {};
  for (const field of values) {
    const equals = field.indexOf("=");
    if (equals < 1) throw new AxiError(`invalid --field: ${field}`, "VALIDATION_ERROR", [
      "Use `--field key=value`",
    ]);
    const key = field.slice(0, equals);
    if (!/^[A-Za-z0-9_.-]+$/.test(key))
      throw new AxiError(`invalid field name: ${key}`, "VALIDATION_ERROR");
    if (key in result)
      throw new AxiError(`--field ${key} may only be given once`, "VALIDATION_ERROR");
    result[key] = parseScalar(field.slice(equals + 1));
  }
  return result;
}

// Parses repeatable `--file <form-field>=<local path>` values into multipart
// parts. The form field name is validated here; the path is checked when read.
export function parseUploads(values: string[]): FileUpload[] {
  return values.map((value) => {
    const equals = value.indexOf("=");
    if (equals < 1)
      throw new AxiError(`invalid --file: ${value}`, "VALIDATION_ERROR", [
        "Use `--file <form-field>=<local path>`, for example `--file files=./shot.png`",
      ]);
    const field = value.slice(0, equals);
    if (!/^[A-Za-z0-9_.-]+$/.test(field))
      throw new AxiError(`invalid multipart field name: ${field}`, "VALIDATION_ERROR");
    const path = value.slice(equals + 1);
    if (!path) throw new AxiError(`--file ${field} requires a path`, "VALIDATION_ERROR");
    return { field, path };
  });
}

export function parseScalar(value: string): Json {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith("{") || value.startsWith("[")) {
    try { return JSON.parse(value) as Json; } catch {
      throw new AxiError("--field contains invalid JSON", "VALIDATION_ERROR");
    }
  }
  return value;
}

export function scalar(value: Json): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function expandApiPath(path: string, ctx?: RepoContext): string {
  if (!path.includes("{")) return path;
  const repo = requireRepo(ctx);
  const expanded = path
    .replaceAll("{workspace}", encodeURIComponent(repo.workspace))
    .replaceAll("{repo}", encodeURIComponent(repo.repo))
    .replaceAll("{repo_slug}", encodeURIComponent(repo.repo));
  if (expanded.includes("{"))
    throw new AxiError("API path contains an unknown placeholder", "VALIDATION_ERROR", [
      "Supported placeholders: {workspace}, {repo}, {repo_slug}",
    ]);
  return expanded;
}

export function truncateJson(value: Json, full: boolean): { value: Json; changed: boolean } {
  if (full) return { value, changed: false };
  if (typeof value === "string") {
    return value.length > 2000
      ? { value: truncate(value, 2000), changed: true }
      : { value, changed: false };
  }
  if (Array.isArray(value)) {
    const children = value.map((item) => truncateJson(item, false));
    return { value: children.map((item) => item.value), changed: children.some((item) => item.changed) };
  }
  if (isObject(value)) {
    let changed = false;
    const result: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      const child = truncateJson(item, false);
      result[key] = child.value;
      changed ||= child.changed;
    }
    return { value: result, changed };
  }
  return { value, changed: false };
}

export function truncate(value: string, length: number): string {
  return `${value.slice(0, length)}… (truncated, ${value.length} chars total)`;
}

export function requiredFlag(parsed: ParsedArgs, name: string): string {
  const value = stringFlag(parsed, name);
  if (!value?.trim()) throw new AxiError(`${name} is required`, "VALIDATION_ERROR");
  return value;
}

export function positiveId(value: string, label: string): number {
  if (!/^\d+$/.test(value) || Number(value) < 1)
    throw new AxiError(`${label} must be a positive integer`, "VALIDATION_ERROR");
  return Number(value);
}

export function noPositionals(parsed: ParsedArgs, command: string): void {
  if (parsed.positionals.length)
    throw new AxiError(`unexpected argument: ${parsed.positionals[0]}`, "VALIDATION_ERROR", [
      `Run \`${command} --help\``,
    ]);
}

export function exactPositionals(parsed: ParsedArgs, count: number, usage: string): void {
  if (parsed.positionals.length !== count)
    throw new AxiError(`expected ${count} argument${count === 1 ? "" : "s"}`, "VALIDATION_ERROR", [
      `Usage: ${usage}`,
    ]);
}

export function subcommandError(group: string, valid: string[], given?: string): AxiError {
  return new AxiError(
    given ? `unknown ${group} subcommand: ${given}` : `${group} subcommand is required`,
    "VALIDATION_ERROR",
    [`Valid subcommands: ${valid.join(", ")}`, `Run \`bitbucket-axi ${group} --help\``],
  );
}

export function object(value: Json): JsonObject {
  if (!isObject(value)) throw new AxiError("Bitbucket returned an unexpected response", "API_ERROR");
  return value;
}

export function jsonArray(value: Json | undefined): Json[] {
  return Array.isArray(value) ? value : [];
}

export function compact(values: Record<string, Json | undefined>): JsonObject {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as JsonObject;
}

export function text(value: JsonObject, key: string): string {
  return typeof value[key] === "string" ? value[key] : "";
}

export function number(value: JsonObject, key: string): number | undefined {
  return typeof value[key] === "number" ? value[key] : undefined;
}

export function nestedText(value: JsonObject, ...keys: string[]): string {
  let current: Json | undefined = value;
  for (const key of keys) {
    if (!isObject(current)) return "";
    current = current[key];
  }
  return typeof current === "string" ? current : "";
}

export function branch(value: JsonObject, side: "source" | "destination"): string {
  return nestedText(value, side, "branch", "name");
}

export function actor(value: Json | undefined): string {
  if (!isObject(value)) return "unknown";
  return text(value, "display_name") || text(value, "nickname") || text(value, "username") || "unknown";
}
