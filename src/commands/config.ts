import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { AxiError } from "axi-sdk-js";
import { boolFlag, parseArgs, stringFlag } from "../args.js";
import { validateCredentials, type Json } from "../client.js";
import {
  clearCredentials,
  clearGitCredentials,
  isValidEmail,
  loadCredentials,
  loadGitCredentials,
  saveCredentials,
  saveGitCredentials,
} from "../credentials.js";
import { noPositionals, requiredFlag, subcommandError } from "./utils.js";

export const CONFIG_HELP = `usage: bitbucket-axi config <subcommand> [flags]
description: Manage Bitbucket Cloud API credentials stored in the OS credential manager.
subcommands[4]:
  set, status, clear, git
flags{set}:
  --email <atlassian-account-email> (otherwise prompted), --token-stdin (non-interactive; read API token from stdin)
flags{status}:
  (none)
flags{clear}:
  (none)
flags{git}:
  git set --token-stdin (separate Git HTTP token for the credential helper), git status, git clear
examples[5]:
  bitbucket-axi config set
  bitbucket-axi config set --email you@example.com
  token-producing-command | bitbucket-axi config set --email you@example.com --token-stdin
  bitbucket-axi config status
  bitbucket-axi config git set --token-stdin
`;

const MAX_TOKEN_BYTES = 8192;

export async function configCommand(args: string[]): Promise<Record<string, Json>> {
  const subcommand = args[0];
  if (!subcommand) throw subcommandError("config", ["set", "status", "clear", "git"]);
  if (subcommand === "set") return configSet(args.slice(1));
  if (subcommand === "status") return configStatus(args.slice(1));
  if (subcommand === "clear") return configClear(args.slice(1));
  if (subcommand === "git") return configGit(args.slice(1));
  throw subcommandError("config", ["set", "status", "clear", "git"], subcommand);
}

interface ConfigSetIO {
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
  stderr?: NodeJS.WritableStream & { isTTY?: boolean };
}

export async function configSet(
  args: string[],
  io: ConfigSetIO = {},
): Promise<Record<string, Json>> {
  const parsed = parseArgs(
    args,
    [{ name: "--email" }, { name: "--token-stdin", boolean: true }],
    "bitbucket-axi config set",
  );
  noPositionals(parsed, "bitbucket-axi config set");
  const stdin = io.stdin ?? process.stdin;
  const stderr = io.stderr ?? process.stderr;
  const tokenFromStdin = boolFlag(parsed, "--token-stdin");

  if (!tokenFromStdin && (!stdin.isTTY || !stderr.isTTY)) {
    throw new AxiError("interactive setup requires a terminal", "VALIDATION_ERROR", [
      "Run `bitbucket-axi config set` in a terminal",
      "For automation, pipe the API token to `bitbucket-axi config set --email <email> --token-stdin`",
    ]);
  }

  let email = stringFlag(parsed, "--email");
  if (!email) {
    email = tokenFromStdin
      ? requiredFlag(parsed, "--email")
      : await readInteractiveLine("Atlassian account email: ", false, stdin, stderr);
  }
  email = email.trim();
  if (!isValidEmail(email))
    throw new AxiError(`invalid email: ${email}`, "VALIDATION_ERROR", [
      "Use your Atlassian account email address",
    ]);

  const tokenInput = tokenFromStdin
    ? await readTokenFromStdin(stdin)
    : await readInteractiveLine("Bitbucket API token: ", true, stdin, stderr);
  const token = tokenInput.trim();
  if (!token)
    throw new AxiError(
      tokenFromStdin ? "no API token received on stdin" : "no API token entered",
      "VALIDATION_ERROR",
      [tokenFromStdin
        ? "Pipe the API token to `bitbucket-axi config set --email <email> --token-stdin`"
        : "Create a Bitbucket API token, then run `bitbucket-axi config set` again"],
    );
  if (Buffer.byteLength(tokenInput) > MAX_TOKEN_BYTES)
    throw new AxiError("API token is too large", "VALIDATION_ERROR", [
      "Enter a single valid Bitbucket API token",
    ]);

  await validateCredentials(email, token);
  saveCredentials({ email, token });
  return {
    config: { email, status: "configured" },
    help: [
      "Run `bitbucket-axi config status` to verify",
      "Run `bitbucket-axi repo view -R <workspace/repo>` to use the CLI",
    ],
  };
}

export async function configStatus(args: string[]): Promise<Record<string, Json>> {
  const parsed = parseArgs(args, [], "bitbucket-axi config status");
  noPositionals(parsed, "bitbucket-axi config status");
  const creds = loadCredentials();
  if (!creds) {
    return {
      config: { ready: false },
      help: ["Run `bitbucket-axi config set` in a terminal"],
    };
  }
  return { config: { email: creds.email, ready: true } };
}

export async function configClear(args: string[]): Promise<Record<string, Json>> {
  const parsed = parseArgs(args, [], "bitbucket-axi config clear");
  noPositionals(parsed, "bitbucket-axi config clear");
  const present = loadCredentials() !== null;
  clearCredentials();
  return { config: { status: present ? "cleared" : "already clear" } };
}

// --- Git HTTP credential helper configuration ---------------------------------
//
// The Git HTTP token is stored in a separate keychain entry from the API token.
// It reuses the configured API account's email as the git username and is
// validated against the same Bitbucket current-user endpoint before storing.
// Default Git transport remains SSH; this is opt-in for HTTPS clones.

export async function configGit(args: string[]): Promise<Record<string, Json>> {
  const subcommand = args[0];
  if (!subcommand) throw subcommandError("config git", ["set", "status", "clear"]);
  if (subcommand === "set") return configGitSet(args.slice(1));
  if (subcommand === "status") return configGitStatus(args.slice(1));
  if (subcommand === "clear") return configGitClear(args.slice(1));
  throw subcommandError("config git", ["set", "status", "clear"], subcommand);
}

export async function configGitSet(
  args: string[],
  readToken: () => Promise<string> = readTokenFromStdin,
): Promise<Record<string, Json>> {
  const parsed = parseArgs(
    args,
    [{ name: "--token-stdin", boolean: true }],
    "bitbucket-axi config git set",
  );
  noPositionals(parsed, "bitbucket-axi config git set");
  if (!boolFlag(parsed, "--token-stdin"))
    throw new AxiError("--token-stdin is required", "VALIDATION_ERROR", [
      "Pipe the Git token via stdin: `bitbucket-axi config git set --token-stdin`",
    ]);
  const apiCreds = loadCredentials();
  if (!apiCreds)
    throw new AxiError("Bitbucket API credentials are not configured", "AUTH_ERROR", [
      "Run `bitbucket-axi config set` first",
      "The Git credential helper reuses the configured account email as its username",
    ]);
  const token = (await readToken()).trim();
  if (!token)
    throw new AxiError("no Git token received on stdin", "VALIDATION_ERROR", [
      "Pipe the Git token from your secret manager to `bitbucket-axi config git set --token-stdin`",
    ]);
  await validateCredentials(apiCreds.email, token);
  saveGitCredentials({ email: apiCreds.email, token });
  return {
    config: { git: "configured", email: apiCreds.email },
    help: [
      "Run `bitbucket-axi config git status` to verify",
      "Run `git config credential.helper 'bitbucket-axi credential-helper'` to use it for HTTPS clones",
    ],
  };
}

export async function configGitStatus(args: string[]): Promise<Record<string, Json>> {
  const parsed = parseArgs(args, [], "bitbucket-axi config git status");
  noPositionals(parsed, "bitbucket-axi config git status");
  const creds = loadGitCredentials();
  if (!creds) {
    return {
      config: { git: "not configured" },
      help: ["Run `bitbucket-axi config git set --token-stdin`"],
    };
  }
  return { config: { git: "configured", email: creds.email } };
}

export async function configGitClear(args: string[]): Promise<Record<string, Json>> {
  const parsed = parseArgs(args, [], "bitbucket-axi config git clear");
  noPositionals(parsed, "bitbucket-axi config git clear");
  const present = loadGitCredentials() !== null;
  clearGitCredentials();
  return { config: { git: present ? "cleared" : "already clear" } };
}

async function readInteractiveLine(
  prompt: string,
  hidden: boolean,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<string> {
  const readlineOutput = hidden
    ? new Writable({ write(_chunk, _encoding, done) { done(); } })
    : output;
  // createInterface enables raw mode before returning. Printing the prompt first
  // let a token pasted at once be echoed by the terminal before that happened.
  const readline = createInterface({ input, output: readlineOutput, terminal: true });
  if (hidden) output.write(prompt);
  try {
    return await readline.question(hidden ? "" : prompt);
  } finally {
    readline.close();
    if (hidden) output.write("\n");
  }
}

export async function readTokenFromStdin(
  stream: NodeJS.ReadableStream = process.stdin,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_TOKEN_BYTES) {
      throw new AxiError("API token on stdin is too large", "VALIDATION_ERROR", [
        "Pipe a single valid Bitbucket API token via stdin",
      ]);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}
