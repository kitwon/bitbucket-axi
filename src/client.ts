import { AxiError } from "axi-sdk-js";
import { loadCredentials, type Credentials } from "./credentials.js";

export type Json = null | boolean | number | string | Json[] | JsonObject;
export interface JsonObject {
  [key: string]: Json;
}

interface RequestOptions {
  method?: string;
  query?: Record<string, string | number | undefined>;
  body?: JsonObject;
}

const API_ROOT = "https://api.bitbucket.org/2.0/";

export function basicAuthHeader(email: string, token: string): string {
  return `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
}

export async function bitbucketRequest(
  path: string,
  options: RequestOptions = {},
): Promise<Json> {
  const creds = loadCredentials();
  if (!creds) {
    throw new AxiError(
      "Bitbucket authentication is not configured",
      "AUTH_ERROR",
      ["Run `bitbucket-axi config set` in a terminal"],
    );
  }

  const normalized = normalizePath(path);
  const url = new URL(normalized, API_ROOT);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }

  let response: Response;
  try {
    response = await globalThis.fetch(url, {
      method: options.method ?? "GET",
      headers: {
        Accept: "application/json",
        Authorization: basicAuthHeader(creds.email, creds.token),
        ...(options.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch {
    throw new AxiError("Could not reach Bitbucket Cloud", "NETWORK_ERROR", [
      "Check network access to api.bitbucket.org and retry",
    ]);
  }

  const text = await response.text();
  const payload = parseResponse(text);
  if (!response.ok) throw apiError(response.status, payload, creds);
  return payload;
}

// Validates an email/token pair against Bitbucket before it is stored. Uses the
// current-user emails endpoint so a single call proves the token authenticates
// AND the email belongs to that token's account. Never persists on failure and
// never leaks the token, the Authorization header, or a stack trace.
export async function validateCredentials(email: string, token: string): Promise<void> {
  let response: Response;
  try {
    response = await globalThis.fetch(`${API_ROOT}user/emails`, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: basicAuthHeader(email, token) },
    });
  } catch {
    throw new AxiError("Could not reach Bitbucket to verify the credentials", "NETWORK_ERROR", [
      "Check network access to api.bitbucket.org and retry `bitbucket-axi config set`",
    ]);
  }

  if (response.status === 401) {
    throw new AxiError("Bitbucket rejected the email or API token", "AUTH_ERROR", [
      "Use your Atlassian account email (not your Bitbucket username)",
      "Create a Bitbucket API token for the same account and retry",
    ]);
  }
  if (response.status === 403) {
    throw new AxiError("The API token lacks the scope to verify your identity", "PERMISSION_ERROR", [
      "Recreate the API token with the `read:user:bitbucket` (or `email`) scope",
      "Retry `bitbucket-axi config set`",
    ]);
  }
  if (!response.ok) {
    throw new AxiError(`Bitbucket credential verification failed (${response.status})`, "API_ERROR", [
      "Retry `bitbucket-axi config set`",
    ]);
  }

  const emails = extractEmails(parseResponse(await response.text()));
  if (!emails.includes(email.toLowerCase())) {
    throw new AxiError("The email does not belong to this API token's account", "AUTH_ERROR", [
      "Use the Atlassian account email that owns the API token",
      "Retry `bitbucket-axi config set`",
    ]);
  }
}

function extractEmails(payload: Json): string[] {
  if (isObject(payload) && Array.isArray(payload["values"])) {
    return payload["values"]
      .filter((item): item is JsonObject => isObject(item) && typeof item["email"] === "string")
      .map((item) => String(item["email"]).toLowerCase());
  }
  return [];
}

function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed.includes("://")) {
    throw new AxiError("API path must be relative to Bitbucket Cloud API v2.0", "VALIDATION_ERROR", [
      "Use a path such as `/repositories/{workspace}/{repo}`",
    ]);
  }
  return trimmed.replace(/^\/+/, "").replace(/^2\.0\//, "");
}

function parseResponse(text: string): Json {
  if (!text) return null;
  try {
    return JSON.parse(text) as Json;
  } catch {
    return text;
  }
}

function apiError(status: number, payload: Json, creds: Credentials): AxiError {
  const detail = apiErrorDetail(payload, creds);
  const withDetail = (message: string) => detail ? `${message}: ${detail}` : message;
  if (status === 401) {
    return new AxiError(withDetail("Bitbucket authentication failed"), "AUTH_ERROR", [
      "The stored API token was rejected; run `bitbucket-axi config set` to update it",
    ]);
  }
  if (status === 403) {
    return new AxiError(withDetail("Bitbucket denied this operation"), "PERMISSION_ERROR", [
      detail
        ? "Check the API token scope and the authenticated account's permission for this resource"
        : "Grant the API token the repository, pull request, or pipeline scope this command needs",
    ]);
  }
  if (status === 404) {
    return new AxiError(withDetail("Bitbucket resource not found"), "NOT_FOUND", [
      "Check the repository selector and resource identifier",
    ]);
  }

  return new AxiError(
    `Bitbucket API request failed (${status})${detail ? `: ${detail}` : ""}`,
    "API_ERROR",
  );
}

function apiErrorDetail(payload: Json, creds: Credentials): string {
  const error = isObject(payload) && isObject(payload["error"]) ? payload["error"] : undefined;
  const rawDetail = typeof error?.["detail"] === "string"
    ? error["detail"]
    : typeof error?.["message"] === "string"
      ? error["message"]
      : "";
  return redact(rawDetail, creds);
}

function redact(message: string, creds: Credentials): string {
  let result = message.replace(/[\r\n\t]+/g, " ").slice(0, 300);
  for (const secret of [creds.email, creds.token]) {
    if (secret) result = result.replaceAll(secret, "[redacted]");
  }
  return result;
}

export function isObject(value: Json | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
