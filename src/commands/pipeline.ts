import { AxiError } from "axi-sdk-js";
import { parseArgs, positiveInt, stringFlag, stringFlags, type ParsedArgs } from "../args.js";
import { bitbucketRequest, type Json, type JsonObject } from "../client.js";
import type { RepoContext } from "../context.js";
import { exactPositionals, jsonArray, noPositionals, number, object, parseFields, pipelineDetail, pipelineListRow, repoHint, repoPath, requiredFlag, requireRepo, subcommandError, text } from "./utils.js";

export const PIPELINE_HELP = `usage: bitbucket-axi pipeline <subcommand> [flags]
subcommands[3]:
  list, view <uuid>, run
flags{list}:
  --status <name>, --limit <1-100> (default 30), --fields <creator,commit,created,completed,duration,url>, -R/--repo <workspace/repo>
flags{view}:
  -R/--repo <workspace/repo>
flags{run}:
  --branch <name>, --custom <pipeline-name>, --variable <key=value> (repeatable), --secured-variable <key=value> (repeatable), -R/--repo <workspace/repo>
examples[4]:
  bitbucket-axi pipeline list
  bitbucket-axi pipeline view "{pipeline-uuid}"
  bitbucket-axi pipeline run --branch main
  bitbucket-axi pipeline run --branch main --custom deploy --variable STAGE=dev
`;

const PIPELINE_LIST_FIELDS = new Set(["creator", "commit", "created", "completed", "duration", "url"]);

export async function pipelineCommand(args: string[], ctx?: RepoContext): Promise<Record<string, Json>> {
  const subcommand = args[0];
  if (!subcommand) throw subcommandError("pipeline", ["list", "view", "run"]);
  if (subcommand === "list") return pipelineList(args.slice(1), requireRepo(ctx));
  if (subcommand === "view") return pipelineView(args.slice(1), requireRepo(ctx));
  if (subcommand === "run") return pipelineRun(args.slice(1), requireRepo(ctx));
  throw subcommandError("pipeline", ["list", "view", "run"], subcommand);
}

async function pipelineList(args: string[], ctx: RepoContext): Promise<Record<string, Json>> {
  const parsed = parseArgs(
    args,
    [{ name: "--status" }, { name: "--limit" }, { name: "--fields" }],
    "bitbucket-axi pipeline list",
  );
  noPositionals(parsed, "bitbucket-axi pipeline list");
  const limit = positiveInt(stringFlag(parsed, "--limit"), "--limit", 30);
  const extras = parseFields(stringFlag(parsed, "--fields"), PIPELINE_LIST_FIELDS, "pipeline list");
  const status = stringFlag(parsed, "--status");
  const payload = object(
    await bitbucketRequest(`${repoPath(ctx)}/pipelines`, {
      query: { pagelen: limit, sort: "-created_on", status: status?.toUpperCase() },
    }),
  );
  const values = jsonArray(payload["values"]);
  const rows = values.map((value) => pipelineListRow(object(value), extras));
  return {
    count: rows.length === 0
      ? `0${status ? ` ${status.toLowerCase()}` : ""} pipelines found in ${ctx.nwo}`
      : `${rows.length} of ${number(payload, "size") ?? rows.length} total`,
    pipelines: rows,
    help: rows.length === 0
      ? [`Run \`bitbucket-axi pipeline run --branch <branch>${repoHint(ctx)}\``]
      : [`Run \`bitbucket-axi pipeline view <uuid>${repoHint(ctx)}\``],
  };
}

async function pipelineView(args: string[], ctx: RepoContext): Promise<Record<string, Json>> {
  const parsed = parseArgs(args, [], "bitbucket-axi pipeline view");
  exactPositionals(parsed, 1, "bitbucket-axi pipeline view <uuid>");
  const id = parsed.positionals[0]!;
  if (!/^\{?[0-9a-f-]{8,}\}?$/i.test(id))
    throw new AxiError("pipeline uuid is invalid", "VALIDATION_ERROR", [
      "Copy the uuid from `bitbucket-axi pipeline list --fields uuid`",
    ]);
  const raw = object(await bitbucketRequest(`${repoPath(ctx)}/pipelines/${encodeURIComponent(id)}`));
  return { pipeline: pipelineDetail(raw) };
}

async function pipelineRun(args: string[], ctx: RepoContext): Promise<Record<string, Json>> {
  const parsed = parseArgs(
    args,
    [
      { name: "--branch" },
      { name: "--custom" },
      { name: "--variable", repeatable: true },
      { name: "--secured-variable", repeatable: true },
    ],
    "bitbucket-axi pipeline run",
  );
  noPositionals(parsed, "bitbucket-axi pipeline run");
  const branchName = requiredFlag(parsed, "--branch");
  const custom = stringFlag(parsed, "--custom");
  const variables = parsePipelineVariables(parsed);
  const target: JsonObject = {
    type: "pipeline_ref_target",
    ref_type: "branch",
    ref_name: branchName,
    ...(custom ? { selector: { type: "custom", pattern: custom } } : {}),
  };
  const raw = object(
    await bitbucketRequest(`${repoPath(ctx)}/pipelines`, {
      method: "POST",
      body: { target, ...(variables.length ? { variables } : {}) },
    }),
  );
  const uuid = text(raw, "uuid");
  return {
    pipeline: pipelineDetail(raw),
    ...(uuid ? { help: [`Run \`bitbucket-axi pipeline view ${uuid}${repoHint(ctx)}\``] } : {}),
  };
}

// Bitbucket rejects variable names outside this set, and values stay untouched
// so `=` and empty strings survive. Input is never echoed: a malformed entry may
// be a secret typed without its `=`.
const VARIABLE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

function parsePipelineVariables(parsed: ParsedArgs): JsonObject[] {
  const entries = [
    ...stringFlags(parsed, "--variable").map((entry) => ({ entry, secured: false })),
    ...stringFlags(parsed, "--secured-variable").map((entry) => ({ entry, secured: true })),
  ];
  const variables: JsonObject[] = [];
  const seen = new Set<string>();
  for (const { entry, secured } of entries) {
    const equals = entry.indexOf("=");
    const key = equals < 1 ? "" : entry.slice(0, equals);
    if (!VARIABLE_KEY.test(key))
      throw new AxiError("invalid pipeline variable", "VALIDATION_ERROR", [
        "Use `--variable <key>=<value>` with a name of ASCII letters, digits, and underscores that does not start with a digit",
        "Run `bitbucket-axi pipeline run --help` for the flag reference",
      ]);
    if (seen.has(key))
      throw new AxiError(`pipeline variable ${key} may only be given once`, "VALIDATION_ERROR");
    seen.add(key);
    variables.push({ key, value: entry.slice(equals + 1), ...(secured ? { secured: true } : {}) });
  }
  return variables;
}
