import { AxiError } from "axi-sdk-js";
import {
  BitbucketHttpError,
  bitbucketRequest,
  isObject,
  type Json,
  type JsonObject,
} from "../client.js";
import type { RepoContext } from "../context.js";
import { compact, jsonArray, nestedText, number, object, repoHint, repoPath, text } from "./utils.js";

const PAGE_SIZE = 100;
const MAX_PAGES = 10;
const MAX_RATE_LIMIT_RETRIES = 5;
const DEFAULT_RETRY_AFTER_SECONDS = 30;
// A `--timeout 0` single round still needs a bound on its own requests.
const SINGLE_ROUND_REQUEST_TIMEOUT_MS = 30_000;

export interface WatchOptions {
  intervalSeconds: number;
  timeoutSeconds: number;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  progress?: (line: string) => void;
}

export interface WatchOutcome {
  output: JsonObject;
  exitCode: number;
}

type WatchReason =
  | "success"
  | "failed"
  | "stopped"
  | "expired"
  | "unknown"
  | "pending"
  | "no-matching-pipeline"
  | "identity-unresolved"
  | "pr-closed"
  | "rate-limited"
  | "interrupted";

type ResultKind = "pass" | "fail" | "pending" | "inconclusive";

interface Evaluation {
  reason: WatchReason;
  terminal: boolean;
}

interface SelectedPipeline {
  selector: string;
  build?: number;
  uuid: string;
  state: string;
  result: string;
  url?: string;
  createdOn: string;
}

// Stops the polling loop without losing the state gathered so far.
class EndWatch extends Error {
  constructor(readonly reason: WatchReason) {
    super(reason);
  }
}

// Watches the source commit of one pull request and reports the native
// Bitbucket Pipelines attached to that exact pull request and commit. The
// selected pipeline per selector is always the newest run, so a rerun replaces
// the run it supersedes.
export async function watchPullRequest(
  ctx: RepoContext,
  id: number,
  options: WatchOptions,
): Promise<WatchOutcome> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const progress = options.progress ?? ((line: string) => process.stderr.write(`${line}\n`));
  const deadline = now() + options.timeoutSeconds * 1000;
  const prPath = `${repoPath(ctx)}/pullrequests/${id}`;

  const selected = new Map<string, SelectedPipeline>();
  const resolvedHeads = new Map<string, string>();
  const printedStates = new Map<string, string>();
  let rawHead = "";
  let fullHead = "";
  let sourceRepo = ctx.nwo;
  let headBranch = "";
  let prState = "";
  let prUrl = "";
  const unidentified = new Set<string>();
  let lastReason: WatchReason = "no-matching-pipeline";
  let polls = 0;

  // Keeps requests inside the watch deadline (except a --timeout 0 round,
  // which gets one bounded request budget instead of waiting).
  const request = async (
    path: string,
    query?: Record<string, string | number | undefined>,
  ): Promise<Json> => {
    for (let attempt = 0; ; attempt++) {
      if (options.signal?.aborted) throw new EndWatch("interrupted");
      const budget = options.timeoutSeconds === 0
        ? SINGLE_ROUND_REQUEST_TIMEOUT_MS
        : deadline - now();
      if (budget <= 0) throw new EndWatch(deadlineReason());
      const controller = new AbortController();
      const cancel = () => controller.abort();
      options.signal?.addEventListener("abort", cancel, { once: true });
      const timer = setTimeout(cancel, Math.max(1, Math.floor(budget)));
      try {
        return await bitbucketRequest(path, { query, signal: controller.signal });
      } catch (error) {
        if (options.signal?.aborted) throw new EndWatch("interrupted");
        if (!(error instanceof BitbucketHttpError) || error.status !== 429) {
          if (options.timeoutSeconds > 0 && now() >= deadline) throw new EndWatch(deadlineReason());
          throw error;
        }
        const wait = Math.max(1, error.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS);
        if (attempt >= MAX_RATE_LIMIT_RETRIES || now() + wait * 1000 >= deadline) {
          throw new EndWatch("rate-limited");
        }
        progress(`rate limited by Bitbucket; retrying in ${wait}s`);
        await sleep(wait * 1000, options.signal);
        if (options.signal?.aborted) throw new EndWatch("interrupted");
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", cancel);
      }
    }
  };

  const deadlineReason = (): WatchReason => {
    if (lastReason === "identity-unresolved") return "identity-unresolved";
    return selected.size === 0 ? "no-matching-pipeline" : "pending";
  };

  const finish = (reason: WatchReason): WatchOutcome => {
    const kind = kindFor(reason);
    const help = helpFor(reason, ctx);
    const pipelines = [...selected.values()]
      .sort((a, b) => a.selector.localeCompare(b.selector))
      .map((run) => compact({
        selector: run.selector,
        build: run.build,
        uuid: run.uuid,
        state: run.state,
        result: run.result || undefined,
        url: run.url,
      }));
    const output: JsonObject = {
      pull_request: compact({
        id,
        state: prState ? prState.toLowerCase() : "unknown",
        url: prUrl || undefined,
      }),
      source: compact({
        repository: sourceRepo,
        branch: headBranch || undefined,
        commit: fullHead || rawHead || undefined,
      }),
      result: kind,
      reason,
      pipelines,
      ...(unidentified.size > 0 ? { unidentified_pipelines: unidentified.size } : {}),
      ...(help.length ? { help } : {}),
    };
    return { output, exitCode: exitCodeFor(reason, kind) };
  };

  const evaluate = (): Evaluation => {
    const runs = [...selected.values()];
    const results = runs
      .filter((run) => run.state === "completed")
      .map((run) => run.result);
    if (results.includes("failed") || results.includes("error"))
      return { reason: "failed", terminal: true };
    if (results.includes("stopped")) return { reason: "stopped", terminal: true };
    if (results.includes("expired")) return { reason: "expired", terminal: true };
    if (runs.some((run) => run.state !== "completed"))
      return { reason: "pending", terminal: false };
    if (results.some((result) => result !== "successful"))
      return { reason: "unknown", terminal: true };
    if (unidentified.size > 0) return { reason: "identity-unresolved", terminal: false };
    if (runs.length === 0) return { reason: "no-matching-pipeline", terminal: false };
    return { reason: "success", terminal: true };
  };

  try {
    progress(`watching PR ${id} in ${ctx.nwo}`);
    for (;;) {
      if (options.signal?.aborted) throw new EndWatch("interrupted");
      // After the first round the deadline stops further polls, including one
      // reached by sleeping exactly to the deadline.
      if (polls > 0 && now() >= deadline) return finish(deadlineReason());
      polls++;

      const pr = object(await request(prPath));
      const nextState = text(pr, "state").toUpperCase() || "UNKNOWN";
      const nextRaw = nestedText(pr, "source", "commit", "hash").toLowerCase();
      prUrl = nestedText(pr, "links", "html", "href") || prUrl;
      if (!nextRaw) {
        throw new AxiError("pull request has no source commit", "API_ERROR", [
          "The pull request head cannot be watched until Bitbucket reports a commit",
        ]);
      }

      if (nextState !== "OPEN") {
        prState = nextState;
        progress(`pull request is ${nextState.toLowerCase()}`);
        const evaluation = evaluate();
        return finish(evaluation.terminal ? evaluation.reason : "pr-closed");
      }

      if (nextRaw !== rawHead) {
        if (rawHead) progress(`head changed from ${rawHead} to ${nextRaw}`);
        rawHead = nextRaw;
        fullHead = "";
        selected.clear();
        lastReason = "no-matching-pipeline";
        unidentified.clear();
        printedStates.clear();
        lastReason = "no-matching-pipeline";
        progress(`head ${nextRaw}${nestedText(pr, "source", "branch", "name") ? ` on ${nestedText(pr, "source", "branch", "name")}` : ""}`);
      }

      prState = nextState;
      sourceRepo = nestedText(pr, "source", "repository", "full_name") || ctx.nwo;
      headBranch = nestedText(pr, "source", "branch", "name") || headBranch;

      fullHead = await resolveHead(request, progress, resolvedHeads, sourceRepo, rawHead);
      await listPipelines(request, ctx, id, fullHead);

      const evaluation = evaluate();
      lastReason = evaluation.reason;
      if (evaluation.terminal) {
        // A terminal run only counts after the same head is still current.
        const confirm = object(await request(prPath));
        const confirmState = text(confirm, "state").toUpperCase();
        const confirmRaw = nestedText(confirm, "source", "commit", "hash").toLowerCase();
        if (confirmState === "OPEN" && confirmRaw === rawHead) {
          prUrl = nestedText(confirm, "links", "html", "href") || prUrl;
          progress(`result ${evaluation.reason}`);
          return finish(evaluation.reason);
        }
        progress("pull request changed while confirming the result; polling again");
        continue;
      }

      if (now() >= deadline) return finish(deadlineReason());
      const remaining = deadline - now();
      await sleep(Math.max(0, Math.min(options.intervalSeconds * 1000, remaining)), options.signal);
      if (options.signal?.aborted) throw new EndWatch("interrupted");
    }
  } catch (error) {
    if (error instanceof EndWatch) return finish(error.reason);
    if (options.signal?.aborted) return finish("interrupted");
    if (options.timeoutSeconds > 0 && now() >= deadline) return finish(deadlineReason());
    throw error;
  }

  async function listPipelines(
    doRequest: typeof request,
    repo: RepoContext,
    prId: number,
    sha: string,
  ): Promise<void> {
    // The API list is authoritative only for runs it still returns. Keep the
    // newest run seen per selector for this head, so a transient omission or a
    // stale page cannot hide a failing run and turn a pass into a false one.
    let path = `${repoPath(repo)}/pipelines`;
    let query: Record<string, string | number | undefined> | undefined = {
      pagelen: PAGE_SIZE,
      sort: "-created_on",
      "target.commit.hash": sha,
    };
    for (let page = 1; ; page++) {
      const payload = object(await doRequest(path, query));
      const scanned = new Map<string, SelectedPipeline>();
      for (const value of jsonArray(payload["values"])) {
        const raw = object(value);
        const classification = classifyPipeline(raw, sha, prId);
        if (classification === "ignore") continue;
        if (classification === "unidentified") {
          unidentified.add(pipelineIdentity(raw));
          continue;
        }
        const run = selectedPipeline(raw);
        const best = scanned.get(run.selector);
        if (!best || isNewer(run, best)) scanned.set(run.selector, run);
      }
      for (const [selector, run] of scanned) {
        const current = selected.get(selector);
        const sameRun =
          (!!current?.uuid && current.uuid === run.uuid) ||
          (current?.build !== undefined && current.build === run.build);
        if (!current || sameRun || isNewer(run, current)) selected.set(selector, run);
      }
      const next = text(payload, "next");
      if (!next) break;
      if (page >= MAX_PAGES) {
        throw new AxiError(
          `Bitbucket returned more than ${MAX_PAGES * PAGE_SIZE} pipelines for this commit`,
          "API_ERROR",
          ["Narrow the watch with a newer head, or inspect `bitbucket-axi pipeline list`"],
        );
      }
      ({ path, query } = nextPage(next));
    }
    for (const [selector, run] of selected) {
      const label = `${run.build ?? run.uuid} ${run.state}${run.result ? `/${run.result}` : ""}`;
      if (printedStates.get(selector) === label) continue;
      printedStates.set(selector, label);
      progress(`build ${run.build ?? run.uuid} (${selector}): ${run.state}${run.result ? `/${run.result}` : ""}`);
    }
  }
}

// Resolves an abbreviated PR head in the source repository, which may be a
// fork, so commit comparison uses the full hash.
async function resolveHead(
  request: (path: string, query?: Record<string, string | number | undefined>) => Promise<Json>,
  progress: (line: string) => void,
  cache: Map<string, string>,
  sourceRepo: string,
  rawHead: string,
): Promise<string> {
  if (/^[0-9a-f]{40}$/.test(rawHead)) return rawHead;
  const cached = cache.get(rawHead);
  if (cached) return cached;
  const payload = object(await request(`${repoApiPath(sourceRepo)}/commit/${encodeURIComponent(rawHead)}`));
  const full = text(payload, "hash").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(full)) {
    throw new AxiError(`could not resolve commit ${rawHead}`, "API_ERROR", [
      `Bitbucket did not return a full commit hash for ${sourceRepo}`,
    ]);
  }
  cache.set(rawHead, full);
  if (full !== rawHead) progress(`resolved ${rawHead} to ${full} in ${sourceRepo}`);
  return full;
}

// Only native pull request pipeline targets for this exact commit and PR can
// produce a verdict. A PR target that lost its commit hash or PR id is
// plausible but unattributable: it is counted and can never yield a pass.
function classifyPipeline(
  raw: JsonObject,
  sha: string,
  prId: number,
): "match" | "unidentified" | "ignore" {
  const target = isObject(raw["target"]) ? raw["target"] : undefined;
  if (!target || text(target, "type") !== "pipeline_pullrequest_target") return "ignore";
  const hash = nestedText(target, "commit", "hash").toLowerCase();
  if (hash && hash !== sha) return "ignore";
  const prRef = isObject(target["pullrequest"]) ? target["pullrequest"] : undefined;
  const targetPr = prRef ? number(prRef, "id") : undefined;
  if (targetPr !== undefined && targetPr !== prId) return "ignore";
  if (!hash || targetPr === undefined) return "unidentified";
  return "match";
}

function selectedPipeline(raw: JsonObject): SelectedPipeline {
  const target = isObject(raw["target"]) ? raw["target"] : undefined;
  return {
    selector: selectorOf(target),
    build: number(raw, "build_number"),
    uuid: text(raw, "uuid"),
    state: (nestedText(raw, "state", "name") || "unknown").toLowerCase(),
    result: nestedText(raw, "state", "result", "name").toLowerCase(),
    url: nestedText(raw, "links", "html", "href") || undefined,
    createdOn: text(raw, "created_on"),
  };
}

function pipelineIdentity(raw: JsonObject): string {
  const uuid = text(raw, "uuid");
  if (uuid) return uuid;
  const build = number(raw, "build_number");
  return build === undefined ? "unknown" : `build-${build}`;
}

function selectorOf(target: JsonObject | undefined): string {
  const selector = target && isObject(target["selector"]) ? target["selector"] : undefined;
  if (!selector) return "default";
  const type = text(selector, "type") || "custom";
  const pattern = text(selector, "pattern") || text(selector, "name");
  return pattern ? `${type}:${pattern}` : type;
}

function isNewer(candidate: SelectedPipeline, current: SelectedPipeline): boolean {
  if (candidate.createdOn && current.createdOn && candidate.createdOn !== current.createdOn)
    return candidate.createdOn > current.createdOn;
  return (candidate.build ?? -1) > (current.build ?? -1);
}

// Follows a pagination link without accepting one outside the Bitbucket API.
function nextPage(next: string): { path: string; query: Record<string, string> } {
  let url: URL;
  try {
    url = new URL(next);
  } catch {
    throw new AxiError("Bitbucket returned an invalid pagination link", "API_ERROR");
  }
  if (url.hostname !== "api.bitbucket.org") {
    throw new AxiError("Bitbucket returned a pagination link outside its API", "API_ERROR", [
      "The watch only follows api.bitbucket.org pages",
    ]);
  }
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams) query[key] = value;
  return { path: url.pathname.replace(/^\/+/, "").replace(/^2\.0\//, ""), query };
}

function repoApiPath(fullName: string): string {
  const parts = fullName.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new AxiError(`invalid source repository: ${fullName || "unknown"}`, "API_ERROR", [
      "The pull request source repository must be `<workspace>/<repo>`",
    ]);
  }
  return `repositories/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

function kindFor(reason: WatchReason): ResultKind {
  if (reason === "success") return "pass";
  if (reason === "failed" || reason === "stopped" || reason === "expired" || reason === "unknown")
    return "fail";
  if (reason === "identity-unresolved" || reason === "pr-closed") return "inconclusive";
  return "pending";
}

function exitCodeFor(reason: WatchReason, kind: ResultKind): number {
  if (reason === "interrupted") return 130;
  if (reason === "rate-limited") return 8;
  if (kind === "pass") return 0;
  if (kind === "fail") return 1;
  if (kind === "pending") return 8;
  return 3;
}

function helpFor(reason: WatchReason, ctx: RepoContext): string[] {
  const hint = repoHint(ctx);
  if (reason === "failed" || reason === "stopped" || reason === "expired" || reason === "unknown")
    return [`Run \`bitbucket-axi pipeline view <uuid>${hint}\` for the selected run`];
  if (reason === "pending")
    return ["At least one selected pipeline was still active at the deadline", "Rerun with a larger --timeout to keep watching"];
  if (reason === "no-matching-pipeline")
    return [
      "Bitbucket reported no native pull request pipeline for this commit before the deadline",
      `Run \`bitbucket-axi pipeline list${hint}\` to inspect all runs`,
    ];
  if (reason === "identity-unresolved")
    return [
      "A pull request pipeline on this commit did not report a pull request id, so it cannot be confirmed or excluded",
      "Inspect that run in Bitbucket before treating CI as passed",
    ];
  if (reason === "pr-closed")
    return ["The pull request left open state before a terminal pipeline result was confirmed"];
  if (reason === "rate-limited")
    return ["Bitbucket rate limiting outlasted the watch deadline", "Retry after the limit clears"];
  if (reason === "interrupted")
    return ["The watch was interrupted before a verdict was confirmed"];
  return [];
}
