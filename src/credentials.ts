import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { Entry } from "@napi-rs/keyring";
import { AxiError } from "axi-sdk-js";

export interface Credentials {
  email: string;
  token: string;
}

// Single keyring entry holds both values as JSON so they are retrieved together.
const SERVICE = "bitbucket-axi";
const ACCOUNT = "bitbucket-cloud";
// Separate entry for the optional Git HTTP credential helper token. Stored
// independently from the API token so a dedicated Git/app-password can be used.
const ACCOUNT_GIT = "bitbucket-cloud-git";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return email.length <= 320 && EMAIL_RE.test(email);
}

function entry(): Entry {
  return new Entry(SERVICE, ACCOUNT);
}

function gitEntry(): Entry {
  return new Entry(SERVICE, ACCOUNT_GIT);
}

export function loadCredentials(): Credentials | null {
  return readStored(entry());
}

export function saveCredentials(creds: Credentials): void {
  writeStored(entry(), creds);
}

export function clearCredentials(): void {
  removeStored(entry());
}

export function loadGitCredentials(): Credentials | null {
  return readStored(gitEntry());
}

export function saveGitCredentials(creds: Credentials): void {
  writeStored(gitEntry(), creds);
}

export function clearGitCredentials(): void {
  removeStored(gitEntry());
}

function readStored(e: Entry): Credentials | null {
  let raw: string | null;
  try {
    raw = e.getPassword();
  } catch (error) {
    if (isLockedError(error)) throw lockedStoreError();
    if (isNoEntryError(error)) return null;
    throw keyringError(error);
  }
  // A locked login keychain is reported as an empty read, not as an error, so a
  // null result alone would claim "no credential" for a stored token.
  if (!raw) {
    if (loginKeychainLocked()) throw lockedStoreError();
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    typeof (parsed as { email?: unknown }).email === "string" &&
    typeof (parsed as { token?: unknown }).token === "string" &&
    (parsed as { email: string }).email &&
    (parsed as { token: string }).token
  ) {
    return {
      email: (parsed as { email: string }).email,
      token: (parsed as { token: string }).token,
    };
  }
  return null;
}

function writeStored(e: Entry, creds: Credentials): void {
  try {
    e.setPassword(JSON.stringify(creds));
  } catch (error) {
    if (isLockedError(error)) throw lockedStoreError();
    throw keyringError(error);
  }
}

function removeStored(e: Entry): void {
  try {
    e.deleteCredential();
  } catch (error) {
    // deleteCredential returns false when no entry exists; a NoEntry-style throw
    // is also treated as success so `config clear` stays idempotent.
    if (!isNoEntryError(error)) throw keyringError(error);
  }
}

function isNoEntryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no (matching )?entry|not found|no credential/i.test(message);
}

const LOCKED_RE = /interaction is not allowed|errSecInteractionNotAllowed/i;

function isLockedError(error: unknown): boolean {
  return LOCKED_RE.test(error instanceof Error ? error.message : String(error));
}

// macOS `security` refuses to read settings from a locked keychain unless it can
// prompt, which an SSH session cannot do; that refusal is the only non-destructive
// signal that separates "locked" from "no entry".
function loginKeychainLocked(): boolean {
  if (process.platform !== "darwin") return false;
  // shortcut: on a desktop session this probe may raise a keychain dialog; gate it
  // on a non-GUI session if that ever proves disruptive.
  const keychain = join(homedir(), "Library", "Keychains", "login.keychain-db");
  const result = spawnSync("security", ["show-keychain-info", keychain], {
    encoding: "utf8",
    timeout: 2000,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return result.status !== 0 && LOCKED_RE.test(output);
}

function lockedStoreError(): AxiError {
  return new AxiError(
    "The login keychain is locked, so the stored credential cannot be read",
    "CREDENTIAL_STORE_ERROR",
    [
      "Unlock it yourself in a terminal: `security unlock-keychain ~/Library/Keychains/login.keychain-db`",
      "Type the keychain password there without -p or -u, then rerun the command; the stored Bitbucket token is reused, so do not re-enter it",
    ],
  );
}

function keyringError(_error: unknown): AxiError {
  // The native error is deliberately not surfaced: it may name the platform
  // backend and never helps the caller act. The structured error + suggestion
  // is the whole actionable surface.
  return new AxiError(
    "Could not access the operating system credential store",
    "CREDENTIAL_STORE_ERROR",
    [
      "Ensure the OS keychain is unlocked and accessible",
      "Run `bitbucket-axi config set` again",
    ],
  );
}
