import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiCommand, prCommand } from "../src/commands/index.js";
import type { RepoContext } from "../src/context.js";

vi.mock("../src/credentials.js", () => ({
  loadCredentials: vi.fn(),
  loadGitCredentials: vi.fn(),
  saveCredentials: vi.fn(),
  clearCredentials: vi.fn(),
  isValidEmail: vi.fn(),
}));
import { loadCredentials } from "../src/credentials.js";
const mockedLoad = vi.mocked(loadCredentials);

const ctx: RepoContext = {
  workspace: "acme",
  repo: "widgets",
  nwo: "acme/widgets",
  source: "flag",
};
const PR_PATH = "/repositories/{workspace}/{repo}/pullrequests/42";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("PR description write contract", () => {
  const fetchMock = vi.fn<typeof fetch>();
  let requests: string[];
  let mutations: Record<string, unknown>[];
  let storedDescription: string;
  let readback: "exact" | "mismatch" | "error";
  let temporaryDirectory: string;

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    mockedLoad.mockReset();
    mockedLoad.mockReturnValue({ email: "agent@example.com", token: "test-token" });
    requests = [];
    mutations = [];
    storedDescription = "";
    readback = "exact";
    temporaryDirectory = mkdtempSync(join(tmpdir(), "bitbucket-axi-pr-body-"));

    fetchMock.mockImplementation((input, init) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      requests.push(`${method} ${url.pathname}`);
      if (method === "GET") {
        if (readback === "error") {
          return Promise.resolve(response({ error: { message: "readback failed" } }, 500));
        }
        const description = readback === "mismatch"
          ? `${storedDescription}\nunexpected`
          : storedDescription;
        return Promise.resolve(response({ id: 42, description }));
      }

      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      mutations.push(body);
      if (typeof body["description"] === "string") storedDescription = body["description"];
      return Promise.resolve(response({ id: 42, description: storedDescription }));
    });
  });

  afterEach(() => {
    rmSync(temporaryDirectory, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  async function rejection(run: () => Promise<unknown>): Promise<{
    message: string;
    code?: string;
    suggestions: string[];
  }> {
    const caught = await run().then(
      () => undefined,
      (error: unknown) => error as { message: string; code?: string; suggestions?: string[] },
    );
    expect(caught, "expected the command to fail").toBeDefined();
    return { message: caught!.message, code: caught!.code, suggestions: caught!.suggestions ?? [] };
  }

  function bodyFile(content: string): string {
    const path = join(temporaryDirectory, "body.md");
    writeFileSync(path, content, "utf8");
    return path;
  }

  it("rejects the observed Python dict repr before any request", async () => {
    const wrapper = String.raw`{'description': "# Summary\n\n| before | after |\n| -- | -- |\n"}`;
    const failed = await rejection(() => prCommand([
      "create",
      "--title",
      "Broken description",
      "--source",
      "fix/broken",
      "--body",
      wrapper,
    ], ctx));

    expect(failed.code).toBe("VALIDATION_ERROR");
    expect(failed.message).toContain("serialized {description: ...} envelope");
    expect(failed.suggestions.join("\n")).toContain("--body-file <path>");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an equivalent JSON object before any request", async () => {
    const wrapper = JSON.stringify({ description: "# Summary\n\nBody" });
    const failed = await rejection(() => apiCommand([
      "PUT",
      PR_PATH,
      "--field",
      `description=${wrapper}`,
    ], ctx));

    expect(failed.code).toBe("VALIDATION_ERROR");
    expect(failed.message).toContain("serialized {description: ...} envelope");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a serialized envelope supplied through --body-file", async () => {
    const failed = await rejection(() => apiCommand([
      "PUT",
      PR_PATH,
      "--body-file",
      bodyFile(String.raw`{"description": "# Summary\n\nBody"}`),
    ], ctx));

    expect(failed.code).toBe("VALIDATION_ERROR");
    expect(failed.message).toContain("serialized {description: ...} envelope");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps description examples in prose and fenced blocks as Markdown", async () => {
    const body = [
      "# Summary",
      "",
      "This prose mentions `description={\"description\":\"example\"}` and a Python repr.",
      "",
      "```json",
      '{"description":"a fenced example"}',
      "```",
      "",
      "```python",
      "payload = {'description': 'another example'}",
      "```",
    ].join("\n");
    await prCommand([
      "create",
      "--title",
      "Markdown examples",
      "--source",
      "fix/examples",
      "--body",
      body,
    ], ctx);

    expect(mutations[0]).toMatchObject({ description: body });
    expect(requests).toEqual([
      "POST /2.0/repositories/acme/widgets/pullrequests",
      "GET /2.0/repositories/acme/widgets/pullrequests/42",
    ]);
  });

  it("preserves a multiline UTF-8 body file through write and exact readback", async () => {
    const body = [
      "# Summary",
      "",
      "Quotes: \"double\" and 'single'; backtick: `code`.",
      "Unicode: 共享登入鎖 café 🚀",
      "",
      "```text",
      "line one",
      "line two with $dollar and \\backslash",
      "```",
      "",
    ].join("\n");
    await prCommand([
      "create",
      "--title",
      "Body file",
      "--source",
      "fix/body-file",
      "--body-file",
      bodyFile(body),
    ], ctx);

    expect(mutations[0]).toMatchObject({ description: body });
    expect(storedDescription).toBe(body);
    expect(requests).toEqual([
      "POST /2.0/repositories/acme/widgets/pullrequests",
      "GET /2.0/repositories/acme/widgets/pullrequests/42",
    ]);
  });

  it("uses --body-file for an existing PR through the raw API route", async () => {
    const body = "# Updated\n\nOne line.\nSecond line.\n";
    await apiCommand(["PUT", PR_PATH, "--body-file", bodyFile(body)], ctx);

    expect(mutations).toEqual([{ description: body }]);
    expect(requests).toEqual([
      "PUT /2.0/repositories/acme/widgets/pullrequests/42",
      "GET /2.0/repositories/acme/widgets/pullrequests/42",
    ]);
  });

  it("reads back a collection POST at the returned pull request id", async () => {
    const body = "# Created\n\nExact body.";
    await apiCommand([
      "POST",
      "/repositories/{workspace}/{repo}/pullrequests",
      "--body-file",
      bodyFile(body),
    ], ctx);

    expect(mutations).toEqual([{ description: body }]);
    expect(requests).toEqual([
      "POST /2.0/repositories/acme/widgets/pullrequests",
      "GET /2.0/repositories/acme/widgets/pullrequests/42",
    ]);
  });

  it("rejects conflicting or missing body inputs before any request", async () => {
    const path = bodyFile("file body");
    const conflict = await rejection(() => prCommand([
      "create",
      "--title",
      "Conflict",
      "--source",
      "fix/conflict",
      "--body",
      "inline body",
      "--body-file",
      path,
    ], ctx));
    expect(conflict.message).toContain("--body and --body-file cannot be combined");

    const apiConflict = await rejection(() => apiCommand([
      "PUT",
      PR_PATH,
      "--body-file",
      path,
      "--field",
      "description=inline body",
    ], ctx));
    expect(apiConflict.message).toContain("--body-file and --field description cannot be combined");

    const missing = await rejection(() => apiCommand([
      "PUT",
      PR_PATH,
      "--body-file",
      join(temporaryDirectory, "missing.md"),
    ], ctx));
    expect(missing.message).toContain("cannot read --body-file");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a saved-body mismatch without retrying or rolling back", async () => {
    readback = "mismatch";
    const failed = await rejection(() => apiCommand([
      "PUT",
      PR_PATH,
      "--field",
      "description=Expected body",
    ], ctx));

    expect(failed.code).toBe("API_ERROR");
    expect(failed.message).toBe("Bitbucket saved a different pull request description");
    expect(failed.suggestions.join("\n")).toContain("no retry or rollback was attempted");
    expect(requests).toEqual([
      "PUT /2.0/repositories/acme/widgets/pullrequests/42",
      "GET /2.0/repositories/acme/widgets/pullrequests/42",
    ]);
    expect(mutations).toHaveLength(1);
  });

  it("reports a failed readback as unverified after the write", async () => {
    readback = "error";
    const failed = await rejection(() => prCommand([
      "create",
      "--title",
      "Unverified",
      "--source",
      "fix/unverified",
      "--body",
      "Written but not readable",
    ], ctx));

    expect(failed.code).toBe("API_ERROR");
    expect(failed.message).toContain("could not verify the saved pull request description");
    expect(failed.suggestions.join("\n")).toContain("The description write succeeded");
    expect(failed.suggestions.join("\n")).toContain("No retry or rollback was attempted");
    expect(requests).toEqual([
      "POST /2.0/repositories/acme/widgets/pullrequests",
      "GET /2.0/repositories/acme/widgets/pullrequests/42",
    ]);
    expect(mutations).toHaveLength(1);
  });
});
