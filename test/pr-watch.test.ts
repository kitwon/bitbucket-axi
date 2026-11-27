import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prCommand } from "../src/commands/index.js";
import { watchPullRequest, type WatchOptions, type WatchOutcome } from "../src/commands/pr-watch.js";
import type { RepoContext } from "../src/context.js";

vi.mock("../src/credentials.js", () => ({
  loadCredentials: vi.fn(() => ({ email: "agent@example.com", token: "test-token" })),
  saveCredentials: vi.fn(),
  clearCredentials: vi.fn(),
  loadGitCredentials: vi.fn(() => undefined),
  saveGitCredentials: vi.fn(),
  clearGitCredentials: vi.fn(),
}));

const fetchMock = vi.fn<typeof fetch>();
const ctx: RepoContext = { workspace: "acme", repo: "widgets", nwo: "acme/widgets", source: "flag" };
const PR_URL = "https://bitbucket.org/acme/widgets/pull-requests/42";
const RAW = "acdef1234567";
const FULL = `${RAW}${"0".repeat(28)}`;
const RAW_B = "bcdef1234567";
const FULL_B = `${RAW_B}${"0".repeat(28)}`;

function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function prPayload(
  options: { state?: string; hash?: string; repo?: string; branch?: string } = {},
) {
  return {
    id: 42,
    state: options.state ?? "OPEN",
    source: {
      repository: { full_name: options.repo ?? "acme/widgets" },
      branch: { name: options.branch ?? "feat/watch" },
      commit: { hash: options.hash ?? RAW },
    },
    links: { html: { href: PR_URL } },
  };
}

interface PipelineOptions {
  prId?: number | null;
  hash?: string;
  type?: string;
  selector?: { type: string; pattern?: string; name?: string };
  state?: string;
  result?: string;
  createdOn?: string;
}

function pipeline(build: number, options: PipelineOptions = {}) {
  const state = options.state ?? "COMPLETED";
  const result = options.result ?? "SUCCESSFUL";
  return {
    uuid: `{uuid-${build}}`,
    build_number: build,
    created_on: options.createdOn ?? `2026-01-01T10:${String(build % 60).padStart(2, "0")}:00Z`,
    target: {
      type: options.type ?? "pipeline_pullrequest_target",
      commit: { hash: options.hash ?? FULL },
      ...(options.selector ? { selector: options.selector } : {}),
      ...(options.prId === null ? {} : { pullrequest: { id: options.prId ?? 42 } }),
    },
    state: {
      name: state,
      ...(state === "COMPLETED" ? { result: { name: result } } : {}),
    },
    links: { html: { href: `https://bitbucket.org/acme/widgets/pipelines/results/${build}` } },
  };
}

function page(values: unknown[], next?: string) {
  return { pagelen: 100, values, ...(next ? { next } : {}) };
}

function serve(handler: (url: URL) => Response | undefined): void {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const result = handler(url);
    if (!result) throw new Error(`unexpected request: ${url.pathname}?${url.searchParams}`);
    return result;
  });
}

function isPrRequest(url: URL): boolean {
  return url.pathname === "/2.0/repositories/acme/widgets/pullrequests/42";
}

function isPipelineRequest(url: URL): boolean {
  return url.pathname === "/2.0/repositories/acme/widgets/pipelines";
}

let clock = 0;
let sleeps: number[] = [];

const now = () => clock;
const sleep = async (ms: number) => {
  sleeps.push(ms);
  clock += ms;
};

async function watch(
  options: Partial<WatchOptions> = {},
): Promise<{ outcome: WatchOutcome; progress: string[] }> {
  const progress: string[] = [];
  const outcome = await watchPullRequest(ctx, 42, {
    intervalSeconds: 10,
    timeoutSeconds: 60,
    now,
    sleep,
    progress: (line) => progress.push(line),
    ...options,
  });
  return { outcome, progress };
}

beforeEach(() => {
  clock = 0;
  sleeps = [];
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  process.exitCode = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.exitCode = undefined;
});

describe("pr watch", () => {
  it("waits for delayed pipeline discovery, resolves an abbreviated hash and passes", async () => {
    let pipelineCalls = 0;
    serve((url) => {
      if (isPrRequest(url)) return response(prPayload());
      if (url.pathname === "/2.0/repositories/acme/widgets/commit/acdef1234567")
        return response({ hash: FULL });
      if (isPipelineRequest(url)) {
        expect(url.searchParams.get("target.commit.hash")).toBe(FULL);
        expect(url.searchParams.get("sort")).toBe("-created_on");
        pipelineCalls++;
        return response(page(pipelineCalls === 1 ? [] : [pipeline(115929)]));
      }
      return undefined;
    });

    const { outcome, progress } = await watch();

    expect(outcome.exitCode).toBe(0);
    expect(outcome.output.result).toBe("pass");
    expect(outcome.output.reason).toBe("success");
    expect(outcome.output.source).toEqual({
      repository: "acme/widgets",
      branch: "feat/watch",
      commit: FULL,
    });
    expect(outcome.output.pipelines).toEqual([
      {
        selector: "default",
        build: 115929,
        uuid: "{uuid-115929}",
        state: "completed",
        result: "successful",
        url: "https://bitbucket.org/acme/widgets/pipelines/results/115929",
      },
    ]);
    expect(pipelineCalls).toBe(2);
    expect(sleeps).toEqual([10_000]);
    expect(progress.some((line) => line.includes(`resolved ${RAW} to ${FULL}`))).toBe(true);
    // The resolved head is cached: only one commit request despite two polls.
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).includes("/commit/")),
    ).toHaveLength(1);
  });

  it("only selects the exact PR target; shared SHA, branch and custom runs are ignored", async () => {
    serve((url) => {
      if (isPrRequest(url)) return response(prPayload());
      if (url.pathname.includes("/commit/")) return response({ hash: FULL });
      if (isPipelineRequest(url))
        return response(page([
          pipeline(101, { prId: 43 }),
          pipeline(102, { prId: null, type: "pipeline_ref_target" }),
          pipeline(103, {
            prId: null,
            type: "pipeline_ref_target",
            selector: { type: "custom", pattern: "deploy" },
          }),
          pipeline(104),
        ]));
      return undefined;
    });

    const { outcome } = await watch({ timeoutSeconds: 0 });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.output.pipelines).toHaveLength(1);
    expect(outcome.output.pipelines).toMatchObject([{ build: 104, state: "completed" }]);
  });

  it("never passes when a plausible PR target lacks its PR identity", async () => {
    serve((url) => {
      if (isPrRequest(url)) return response(prPayload());
      if (url.pathname.includes("/commit/")) return response({ hash: FULL });
      if (isPipelineRequest(url))
        return response(page([pipeline(201), pipeline(202, { prId: null })]));
      return undefined;
    });

    const { outcome } = await watch({ timeoutSeconds: 0 });

    expect(outcome.exitCode).toBe(3);
    expect(outcome.output.result).toBe("inconclusive");
    expect(outcome.output.reason).toBe("identity-unresolved");
    expect(outcome.output.unidentified_pipelines).toBe(1);
  });

  it("selects the newest run per selector, so a rerun replaces an older pass", async () => {
    let pipelineCalls = 0;
    serve((url) => {
      if (isPrRequest(url)) return response(prPayload());
      if (url.pathname.includes("/commit/")) return response({ hash: FULL });
      if (isPipelineRequest(url)) {
        pipelineCalls++;
        const rerun = pipeline(302, {
          createdOn: "2026-01-01T11:00:00Z",
          state: pipelineCalls === 1 ? "IN_PROGRESS" : "COMPLETED",
        });
        return response(page([
          pipeline(301, { createdOn: "2026-01-01T10:00:00Z" }),
          rerun,
        ]));
      }
      return undefined;
    });

    const { outcome, progress } = await watch();

    expect(outcome.exitCode).toBe(0);
    expect(outcome.output.pipelines).toMatchObject([{ build: 302, state: "completed" }]);
    expect(progress.some((line) => line.includes("build 302 (default): in_progress"))).toBe(true);
    expect(progress.some((line) => line.includes("build 302 (default): completed/successful"))).toBe(true);
  });

  it("follows a head change and ignores the previous head's result", async () => {
    let prCalls = 0;
    let pipelineBCalls = 0;
    serve((url) => {
      if (isPrRequest(url)) {
        prCalls++;
        // The first confirmation sees a new head; later reads see that head.
        return response(prPayload({ hash: prCalls === 2 ? RAW_B : prCalls === 1 ? RAW : RAW_B }));
      }
      if (url.pathname.includes("/commit/"))
        return response({ hash: url.pathname.endsWith(RAW_B) ? FULL_B : FULL });
      if (isPipelineRequest(url)) {
        if (url.searchParams.get("target.commit.hash") === FULL_B) {
          pipelineBCalls++;
          return response(page(pipelineBCalls === 1 ? [] : [pipeline(402, { hash: FULL_B })]));
        }
        return response(page([pipeline(401, { hash: FULL })]));
      }
      return undefined;
    });

    const { outcome, progress } = await watch();

    expect(outcome.exitCode).toBe(0);
    expect(outcome.output.source).toMatchObject({ commit: FULL_B });
    expect(outcome.output.pipelines).toMatchObject([{ build: 402 }]);
    expect(progress.some((line) => line.includes(`head changed from ${RAW} to ${RAW_B}`))).toBe(true);
  });

  it("keeps a remembered selector when a later poll omits it, so it cannot turn into a pass", async () => {
    let pipelineCalls = 0;
    serve((url) => {
      if (isPrRequest(url)) return response(prPayload());
      if (url.pathname.includes("/commit/")) return response({ hash: FULL });
      if (isPipelineRequest(url)) {
        pipelineCalls++;
        if (pipelineCalls === 1)
          return response(page([
            pipeline(601, { state: "IN_PROGRESS" }),
            pipeline(602, { state: "IN_PROGRESS", selector: { type: "custom", pattern: "deploy" } }),
          ]));
        if (pipelineCalls === 2)
          return response(page([
            pipeline(601),
            pipeline(602, { state: "IN_PROGRESS", selector: { type: "custom", pattern: "deploy" } }),
          ]));
        return response(page([pipeline(601)]));
      }
      return undefined;
    });

    const { outcome } = await watch({ timeoutSeconds: 25 });

    expect(outcome.exitCode).toBe(8);
    expect(outcome.output.result).toBe("pending");
    expect(outcome.output.pipelines).toMatchObject([
      { selector: "custom:deploy", build: 602, state: "in_progress" },
      { selector: "default", build: 601, state: "completed", result: "successful" },
    ]);
    expect(sleeps).toEqual([10_000, 10_000, 5_000]);
  });

  it("keeps an unidentified PR target ambiguous even when a later poll omits it", async () => {
    let pipelineCalls = 0;
    serve((url) => {
      if (isPrRequest(url)) return response(prPayload());
      if (url.pathname.includes("/commit/")) return response({ hash: FULL });
      if (isPipelineRequest(url)) {
        pipelineCalls++;
        return response(
          page(pipelineCalls === 1 ? [pipeline(701), pipeline(702, { prId: null })] : [pipeline(701)]),
        );
      }
      return undefined;
    });

    const { outcome } = await watch({ timeoutSeconds: 15 });

    expect(outcome.exitCode).toBe(3);
    expect(outcome.output.result).toBe("inconclusive");
    expect(outcome.output.reason).toBe("identity-unresolved");
    expect(outcome.output.unidentified_pipelines).toBe(1);
  });

  it("requires every selected selector to finish before passing", async () => {
    serve((url) => {
      if (isPrRequest(url)) return response(prPayload());
      if (url.pathname.includes("/commit/")) return response({ hash: FULL });
      if (isPipelineRequest(url))
        return response(page([
          pipeline(501),
          pipeline(502, {
            state: "IN_PROGRESS",
            selector: { type: "custom", pattern: "deploy" },
          }),
        ]));
      return undefined;
    });

    const { outcome } = await watch({ timeoutSeconds: 25 });

    expect(outcome.exitCode).toBe(8);
    expect(outcome.output.result).toBe("pending");
    expect(outcome.output.reason).toBe("pending");
    expect(outcome.output.pipelines).toMatchObject([
      { selector: "custom:deploy", build: 502, state: "in_progress" },
      { selector: "default", build: 501 },
    ]);
  });

  it.each([
    ["FAILED", "failed", 1],
    ["ERROR", "failed", 1],
    ["STOPPED", "stopped", 1],
    ["EXPIRED", "expired", 1],
    ["UNRECOGNIZED", "unknown", 1],
  ])("surfaces %s as a distinct non-passing result", async (result, reason, exitCode) => {
    serve((url) => {
      if (isPrRequest(url)) return response(prPayload());
      if (url.pathname.includes("/commit/")) return response({ hash: FULL });
      if (isPipelineRequest(url)) return response(page([pipeline(601, { result })]));
      return undefined;
    });

    const { outcome } = await watch({ timeoutSeconds: 0 });

    expect(outcome.exitCode).toBe(exitCode);
    expect(outcome.output.result).toBe("fail");
    expect(outcome.output.reason).toBe(reason);
  });

  it("keeps polling a paused run and times out with a distinct pending reason", async () => {
    serve((url) => {
      if (isPrRequest(url)) return response(prPayload());
      if (url.pathname.includes("/commit/")) return response({ hash: FULL });
      if (isPipelineRequest(url)) return response(page([pipeline(701, { state: "PENDING" })]));
      return undefined;
    });

    const { outcome, progress } = await watch({ timeoutSeconds: 30 });

    expect(outcome.exitCode).toBe(8);
    expect(outcome.output.result).toBe("pending");
    expect(outcome.output.reason).toBe("pending");
    expect(sleeps).toEqual([10_000, 10_000, 10_000]);
    expect(progress.filter((line) => line.includes("build 701"))).toHaveLength(1);
  });

  it("bounds the final sleep by the deadline", async () => {
    serve((url) => {
      if (isPrRequest(url)) return response(prPayload());
      if (url.pathname.includes("/commit/")) return response({ hash: FULL });
      if (isPipelineRequest(url)) return response(page([pipeline(801, { state: "IN_PROGRESS" })]));
      return undefined;
    });

    const { outcome } = await watch({ timeoutSeconds: 15 });

    expect(outcome.exitCode).toBe(8);
    expect(sleeps).toEqual([10_000, 5_000]);
  });

  it("reports no matching pipeline when only other target types exist", async () => {
    serve((url) => {
      if (isPrRequest(url)) return response(prPayload());
      if (url.pathname.includes("/commit/")) return response({ hash: FULL });
      if (isPipelineRequest(url))
        return response(page([
          pipeline(901, { prId: null, type: "pipeline_ref_target" }),
        ]));
      return undefined;
    });

    const { outcome } = await watch({ timeoutSeconds: 0 });

    expect(outcome.exitCode).toBe(8);
    expect(outcome.output.result).toBe("pending");
    expect(outcome.output.reason).toBe("no-matching-pipeline");
    expect(outcome.output.pipelines).toEqual([]);
  });

  it("waits out a 429 using Retry-After, then passes", async () => {
    let pipelineCalls = 0;
    serve((url) => {
      if (isPrRequest(url)) return response(prPayload());
      if (url.pathname.includes("/commit/")) return response({ hash: FULL });
      if (isPipelineRequest(url)) {
        pipelineCalls++;
        if (pipelineCalls === 1) return response({ error: { message: "rate limited" } }, 429, { "retry-after": "3" });
        return response(page([pipeline(1001)]));
      }
      return undefined;
    });

    const { outcome, progress } = await watch({ timeoutSeconds: 30 });

    expect(outcome.exitCode).toBe(0);
    expect(sleeps).toEqual([3_000]);
    expect(progress.some((line) => line.includes("rate limited"))).toBe(true);
    expect(pipelineCalls).toBe(2);
  });

  it("stops without a verdict when rate limiting outlasts the deadline", async () => {
    serve((url) => {
      if (isPrRequest(url)) return response(prPayload());
      if (url.pathname.includes("/commit/")) return response({ hash: FULL });
      if (isPipelineRequest(url)) return response({ error: {} }, 429, { "retry-after": "60" });
      return undefined;
    });

    const { outcome } = await watch({ timeoutSeconds: 10 });

    expect(outcome.exitCode).toBe(8);
    expect(outcome.output.result).toBe("pending");
    expect(outcome.output.reason).toBe("rate-limited");
    expect(sleeps).toEqual([]);
  });

  it("returns interrupted without a verdict when signalled before the first poll", async () => {
    serve(() => response(prPayload()));
    const controller = new AbortController();
    controller.abort();

    const { outcome, progress } = await watch({ signal: controller.signal });

    expect(outcome.exitCode).toBe(130);
    expect(outcome.output.result).toBe("pending");
    expect(outcome.output.reason).toBe("interrupted");
    expect(progress[0]).toContain("watching PR 42");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("interrupts a wait when the signal aborts during sleep", async () => {
    serve((url) => {
      if (isPrRequest(url)) return response(prPayload());
      if (url.pathname.includes("/commit/")) return response({ hash: FULL });
      if (isPipelineRequest(url)) return response(page([pipeline(1101, { state: "IN_PROGRESS" })]));
      return undefined;
    });
    const controller = new AbortController();
    const abortingSleep = async (ms: number) => {
      sleeps.push(ms);
      clock += ms;
      controller.abort();
    };

    const { outcome } = await watch({ signal: controller.signal, sleep: abortingSleep });

    expect(outcome.exitCode).toBe(130);
    expect(outcome.output.reason).toBe("interrupted");
  });

  it("exits without a verdict when the PR is closed before a result", async () => {
    serve((url) =>
      isPrRequest(url) ? response(prPayload({ state: "MERGED" })) : undefined,
    );

    const { outcome } = await watch();

    expect(outcome.exitCode).toBe(3);
    expect(outcome.output.result).toBe("inconclusive");
    expect(outcome.output.reason).toBe("pr-closed");
    expect(outcome.output.pull_request).toMatchObject({ state: "merged", url: PR_URL });
  });

  it("keeps a verdict established before the PR closed", async () => {
    let prCalls = 0;
    serve((url) => {
      if (isPrRequest(url)) {
        prCalls++;
        return response(prPayload({ state: prCalls >= 2 ? "MERGED" : "OPEN" }));
      }
      if (url.pathname.includes("/commit/")) return response({ hash: FULL });
      if (isPipelineRequest(url)) return response(page([pipeline(1201)]));
      return undefined;
    });

    const { outcome } = await watch();

    expect(outcome.exitCode).toBe(0);
    expect(outcome.output.result).toBe("pass");
    expect(outcome.output.pull_request).toMatchObject({ state: "merged" });
  });

  it("follows pagination instead of trusting the first page", async () => {
    const next =
      "https://api.bitbucket.org/2.0/repositories/acme/widgets/pipelines" +
      `?pagelen=100&page=2&sort=-created_on&target.commit.hash=${FULL}`;
    serve((url) => {
      if (isPrRequest(url)) return response(prPayload());
      if (url.pathname.includes("/commit/")) return response({ hash: FULL });
      if (isPipelineRequest(url)) {
        if (url.searchParams.get("page") === "2") return response(page([pipeline(1301)]));
        return response(page([], next));
      }
      return undefined;
    });

    const { outcome } = await watch({ timeoutSeconds: 0 });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.output.pipelines).toMatchObject([{ build: 1301 }]);
  });

  it("resolves an abbreviated head in the fork source repository", async () => {
    const requested: string[] = [];
    serve((url) => {
      requested.push(url.pathname);
      if (isPrRequest(url)) return response(prPayload({ repo: "acme/fork" }));
      if (url.pathname === "/2.0/repositories/acme/fork/commit/acdef1234567")
        return response({ hash: FULL });
      if (isPipelineRequest(url)) return response(page([pipeline(1401)]));
      return undefined;
    });

    const { outcome } = await watch({ timeoutSeconds: 0 });

    expect(outcome.exitCode).toBe(0);
    expect(outcome.output.source).toMatchObject({ repository: "acme/fork", commit: FULL });
    expect(requested).toContain("/2.0/repositories/acme/fork/commit/acdef1234567");
    // Pipelines are discovered in the PR (destination) repository.
    expect(requested).toContain("/2.0/repositories/acme/widgets/pipelines");
    expect(requested).not.toContain("/2.0/repositories/acme/fork/pipelines");
  });

  it("wires exit codes and output through the CLI command", async () => {
    serve((url) => {
      if (isPrRequest(url)) return response(prPayload());
      if (url.pathname.includes("/commit/")) return response({ hash: FULL });
      if (isPipelineRequest(url)) return response(page([pipeline(1501)]));
      return undefined;
    });

    const output = await prCommand(["watch", "42", "--timeout", "0"], ctx);

    expect(output.result).toBe("pass");
    expect(process.exitCode).toBeUndefined();
  });

  it("rejects invalid watch flags before any request", async () => {
    await expect(prCommand(["watch", "42", "--interval", "abc"], ctx)).rejects.toThrow(
      "--interval must be an integer from 1 to 300",
    );
    await expect(prCommand(["watch", "42", "--timeout", "86401"], ctx)).rejects.toThrow(
      "--timeout must be an integer from 0 to 86400",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
