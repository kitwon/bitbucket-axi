import { AxiError } from "axi-sdk-js";
import { boolFlag, parseArgs, positiveInt, stringFlag } from "../args.js";
import { bitbucketRequest, type Json, type JsonObject } from "../client.js";
import type { RepoContext } from "../context.js";
import { assertPrBodyImages } from "../pr-body.js";
import { actor, branch, compact, exactPositionals, jsonArray, nestedText, noPositionals, number, object, parseFields, positiveId, prListRow, repoHint, repoPath, requiredFlag, requireRepo, subcommandError, text, truncate } from "./utils.js";

export const PR_HELP = `usage: bitbucket-axi pr <subcommand> [flags]
subcommands[3]:
  list, view <id>, create
flags{list}:
  --state <open|merged|declined|superseded|all> (default open), --limit <1-100> (default 30), --fields <source,destination,created,url,draft,comments>, -R/--repo <workspace/repo>
flags{view}:
  --full, -R/--repo <workspace/repo>
flags{create}:
  --title <text>, --source <branch>, --destination <branch>, --body <text>, --close-source, -R/--repo <workspace/repo>
notes[1]:
  --body is checked before it is sent: every Downloads image it references must exist under its exact URL name.
examples[3]:
  bitbucket-axi pr list --state open
  bitbucket-axi pr view 42 --full
  bitbucket-axi pr create --title "Fix auth" --source fix/auth --destination main
`;

const PR_LIST_FIELDS = new Set(["source", "destination", "created", "url", "draft", "comments"]);

export async function prCommand(args: string[], ctx?: RepoContext): Promise<Record<string, Json>> {
  const subcommand = args[0];
  if (!subcommand) throw subcommandError("pr", ["list", "view", "create"]);
  if (subcommand === "list") return prList(args.slice(1), requireRepo(ctx));
  if (subcommand === "view") return prView(args.slice(1), requireRepo(ctx));
  if (subcommand === "create") return prCreate(args.slice(1), requireRepo(ctx));
  throw subcommandError("pr", ["list", "view", "create"], subcommand);
}

async function prList(args: string[], ctx: RepoContext): Promise<Record<string, Json>> {
  const parsed = parseArgs(
    args,
    [
      { name: "--state" },
      { name: "--limit" },
      { name: "--fields" },
    ],
    "bitbucket-axi pr list",
  );
  noPositionals(parsed, "bitbucket-axi pr list");
  const state = (stringFlag(parsed, "--state") ?? "open").toLowerCase();
  if (!["open", "merged", "declined", "superseded", "all"].includes(state))
    throw new AxiError(`invalid --state: ${state}`, "VALIDATION_ERROR", [
      "Use open, merged, declined, superseded, or all",
    ]);
  const limit = positiveInt(stringFlag(parsed, "--limit"), "--limit", 30);
  const extras = parseFields(stringFlag(parsed, "--fields"), PR_LIST_FIELDS, "pr list");
  const payload = object(
    await bitbucketRequest(`${repoPath(ctx)}/pullrequests`, {
      query: {
        pagelen: limit,
        sort: "-updated_on",
        state: state === "all" ? undefined : state.toUpperCase(),
      },
    }),
  );
  const values = jsonArray(payload["values"]);
  const rows = values.map((value) => prListRow(object(value), extras));
  const description = state === "all" ? "pull requests" : `${state} pull requests`;
  return {
    count: rows.length === 0
      ? `0 ${description} found in ${ctx.nwo}`
      : `${rows.length} of ${number(payload, "size") ?? rows.length} total`,
    pull_requests: rows,
    help: rows.length === 0
      ? [`Run \`bitbucket-axi pr create --title "<title>" --source <branch>${repoHint(ctx)}\``]
      : [`Run \`bitbucket-axi pr view <id>${repoHint(ctx)}\``],
  };
}

async function prView(args: string[], ctx: RepoContext): Promise<Record<string, Json>> {
  const parsed = parseArgs(args, [{ name: "--full", boolean: true }], "bitbucket-axi pr view");
  exactPositionals(parsed, 1, "bitbucket-axi pr view <id>");
  const id = positiveId(parsed.positionals[0]!, "pull request id");
  const raw = object(await bitbucketRequest(`${repoPath(ctx)}/pullrequests/${id}`));
  const description = text(raw, "description");
  const truncated = !boolFlag(parsed, "--full") && description.length > 700;
  return {
    pull_request: compact({
      id: number(raw, "id") ?? id,
      title: text(raw, "title"),
      state: text(raw, "state").toLowerCase(),
      author: actor(raw["author"]),
      source: branch(raw, "source"),
      destination: branch(raw, "destination"),
      draft: raw["draft"] === true ? "yes" : "no",
      comments: number(raw, "comment_count") ?? 0,
      created: text(raw, "created_on"),
      updated: text(raw, "updated_on"),
      url: nestedText(raw, "links", "html", "href"),
      description: truncated ? truncate(description, 700) : description || "none",
    }),
    ...(truncated ? { help: [`Run \`bitbucket-axi pr view ${id} --full${repoHint(ctx)}\``] } : {}),
  };
}

async function prCreate(args: string[], ctx: RepoContext): Promise<Record<string, Json>> {
  const parsed = parseArgs(
    args,
    [
      { name: "--title" },
      { name: "--source" },
      { name: "--destination" },
      { name: "--body" },
      { name: "--close-source", boolean: true },
    ],
    "bitbucket-axi pr create",
  );
  noPositionals(parsed, "bitbucket-axi pr create");
  const title = requiredFlag(parsed, "--title");
  const source = requiredFlag(parsed, "--source");
  const destination = stringFlag(parsed, "--destination");
  const description = stringFlag(parsed, "--body");
  if (description) await assertPrBodyImages(description);
  const body: JsonObject = {
    title,
    source: { branch: { name: source } },
    ...(destination ? { destination: { branch: { name: destination } } } : {}),
    ...(description ? { description } : {}),
    ...(boolFlag(parsed, "--close-source") ? { close_source_branch: true } : {}),
  };
  const raw = object(await bitbucketRequest(`${repoPath(ctx)}/pullrequests`, { method: "POST", body }));
  const id = number(raw, "id");
  return {
    pull_request: compact({
      id,
      title: text(raw, "title") || title,
      state: text(raw, "state").toLowerCase() || "open",
      source: branch(raw, "source") || source,
      destination: branch(raw, "destination") || destination || "default branch",
      url: nestedText(raw, "links", "html", "href"),
    }),
    ...(id !== undefined ? { help: [`Run \`bitbucket-axi pr view ${id}${repoHint(ctx)}\``] } : {}),
  };
}
