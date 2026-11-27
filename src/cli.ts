import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encode } from "@toon-format/toon";
import { AxiError, runAxiCli } from "axi-sdk-js";
import { stripRepoFlag } from "./args.js";
import {
  API_HELP,
  CONFIG_HELP,
  CREDENTIAL_HELPER_HELP,
  PIPELINE_HELP,
  PR_HELP,
  REPO_HELP,
  apiCommand,
  configCommand,
  credentialHelperCommand,
  homeCommand,
  pipelineCommand,
  prCommand,
  repoCommand,
} from "./commands/index.js";
import { resolveRepo, type RepoContext } from "./context.js";

export const DESCRIPTION = "Inspect repositories, pull requests, and pipelines in Bitbucket Cloud with agent-efficient output.";
export const TOP_HELP = `usage: bitbucket-axi [command] [args] [flags]
commands[6]:
  repo view, pr list|view|create|watch, pipeline list|view|run, api, config set|status|clear|git, credential-helper
flags[3]:
  -R/--repo <workspace/repo> (after command), --help, -v/-V/--version
examples[4]:
  bitbucket-axi
  bitbucket-axi repo view -R workspace/repo
  bitbucket-axi pr list --state open
  bitbucket-axi pipeline run --branch main
`;

const VERSION = readPackageVersion();
const HELP: Record<string, string> = {
  repo: REPO_HELP,
  pr: PR_HELP,
  pipeline: PIPELINE_HELP,
  api: API_HELP,
  config: CONFIG_HELP,
  "credential-helper": CREDENTIAL_HELPER_HELP,
};

type Handler = (args: string[], ctx?: RepoContext) => Promise<Record<string, unknown>>;

export async function main(options: {
  argv?: string[];
  stdout?: { write(chunk: string): unknown };
} = {}): Promise<void> {
  // Resolve repository context inside handlers so SDK error formatting also covers
  // invalid selectors and git detection failures.
  const wrap = (handler: Handler) => (args: string[]) =>
    handler(stripRepoFlag(args), resolveRepo(args));

  await runAxiCli({
    ...(options.argv ? { argv: options.argv } : {}),
    ...(options.stdout ? { stdout: options.stdout } : {}),
    description: DESCRIPTION,
    version: VERSION,
    packageName: "bitbucket-axi",
    topLevelHelp: TOP_HELP,
    commands: {
      repo: wrap(repoCommand),
      pr: wrap(prCommand),
      pipeline: wrap(pipelineCommand),
      api: wrap(apiCommand),
      config: configCommand,
      // Read-only Git credential helper: returns raw protocol text (not TOON),
      // so it is registered without repo-context wrapping.
      "credential-helper": (args) => credentialHelperCommand(args),
      // Shadow the SDK's update command: this deliberately bounded release has no updater.
      update: async () => {
        throw new AxiError("Unknown command: update", "VALIDATION_ERROR", [
          "Run `bitbucket-axi --help` to see available commands",
        ]);
      },
    },
    home: (args) => homeCommand(args, resolveRepo(args)),
    getCommandHelp: (command) => HELP[command],
    formatError: formatError,
  });
}

function formatError(error: unknown): { output: string; exitCode: number } {
  if (error instanceof AxiError) {
    return {
      output: `${encode({
        error: error.message,
        code: error.code,
        ...(error.suggestions.length ? { help: error.suggestions } : {}),
      })}\n`,
      exitCode: error.code === "VALIDATION_ERROR" ? 2 : 1,
    };
  }
  return {
    output: `${encode({
      error: "Unexpected failure",
      code: "INTERNAL_ERROR",
      help: ["Retry with validated arguments; report the command if the failure persists"],
    })}\n`,
    exitCode: 1,
  };
}

function readPackageVersion(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    const path = join(directory, "package.json");
    if (existsSync(path)) {
      try {
        const value = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown };
        if (typeof value.version === "string") return value.version;
      } catch {
        break;
      }
    }
    directory = dirname(directory);
  }
  return "0.0.0";
}
