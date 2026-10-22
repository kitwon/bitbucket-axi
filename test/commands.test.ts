import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encode } from "@toon-format/toon";
import { apiCommand, homeCommand, pipelineCommand, prCommand, repoCommand } from "../src/commands/index.js";
import type { RepoContext } from "../src/context.js";

// Credentials are supplied by mocking the credential module so the real OS
// keychain is never touched by these command tests.
vi.mock("../src/credentials.js", () => ({
  loadCredentials: vi.fn(),
  loadGitCredentials: vi.fn(),
  saveCredentials: vi.fn(),
  clearCredentials: vi.fn(),
  isValidEmail: vi.fn(),
}));
import { loadCredentials, loadGitCredentials } from "../src/credentials.js";
const mockedLoad = vi.mocked(loadCredentials);
const mockedGitLoad = vi.mocked(loadGitCredentials);

const ctx: RepoContext = {
  workspace: "acme",
  repo: "widgets",
  nwo: "acme/widgets",
  source: "flag",
};

function response(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Bitbucket commands", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    mockedLoad.mockReset();
    mockedGitLoad.mockReset();
    mockedLoad.mockReturnValue({ email: "agent@example.com", token: "test-token" });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("makes no API call when credentials are not configured", async () => {
    mockedLoad.mockReturnValue(null);
    await expect(repoCommand(["view"], ctx)).rejects.toThrow(
      "Bitbucket authentication is not configured",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("points to the config command when credentials are missing", async () => {
    mockedLoad.mockReturnValue(null);
    let caught: unknown;
    try {
      await repoCommand(["view"], ctx);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(JSON.stringify(caught)).toContain("bitbucket-axi config set` in a terminal");
  });

  it("translates an HTTP authentication failure", async () => {
    fetchMock.mockResolvedValue(response({ error: { message: "bad credentials" } }, 401));
    await expect(repoCommand(["view"], ctx)).rejects.toThrow("Bitbucket authentication failed");
  });

  it("sends a Basic auth header built from the stored email and token", async () => {
    fetchMock.mockResolvedValue(response({ size: 0, pagelen: 30, values: [] }));
    await prCommand(["list"], ctx);
    const [, init] = fetchMock.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(
      `Basic ${Buffer.from("agent@example.com:test-token").toString("base64")}`,
    );
  });

  it("never leaks the token in error output", async () => {
    fetchMock.mockResolvedValue(response({ error: { message: "test-token visible here" } }, 500));
    let caught: unknown;
    try {
      await repoCommand(["view"], ctx);
    } catch (error) {
      caught = error;
    }
    const rendered = encode({
      error: (caught as { message: string }).message,
      code: (caught as { code: string }).code,
    });
    expect(rendered).not.toContain("test-token");
  });

  it("prints a definitive empty pull request list", async () => {
    fetchMock.mockResolvedValue(response({ size: 0, pagelen: 30, values: [] }));
    const output = await prCommand(["list"], ctx);
    const toon = encode(output);
    expect(toon).toContain("0 open pull requests found in acme/widgets");
    expect(toon).toContain("pull_requests: []");
  });

  it("renders representative pull request detail", async () => {
    fetchMock.mockResolvedValue(response({
      id: 42,
      title: "Fix auth",
      state: "OPEN",
      author: { display_name: "Ada" },
      source: { branch: { name: "fix/auth" } },
      destination: { branch: { name: "main" } },
      description: "Details",
      comment_count: 2,
      links: { html: { href: "https://bitbucket.org/acme/widgets/pull-requests/42" } },
    }));
    const output = await prCommand(["view", "42"], ctx);
    expect(output["pull_request"]).toMatchObject({
      id: 42,
      title: "Fix auth",
      author: "Ada",
      source: "fix/auth",
      destination: "main",
    });
  });

  it("creates a pull request with the stored API credential", async () => {
    mockedGitLoad.mockImplementation(() => {
      throw new Error("Git credentials are not configured");
    });
    fetchMock.mockResolvedValue(response({
      id: 7,
      title: "Fix auth",
      state: "OPEN",
      source: { branch: { name: "fix/auth" } },
      destination: { branch: { name: "main" } },
    }, 201));
    const output = await prCommand([
      "create",
      "--title", "Fix auth",
      "--source", "fix/auth",
      "--destination", "main",
      "--close-source",
    ], ctx);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["Authorization"]).toBe(
      `Basic ${Buffer.from("agent@example.com:test-token").toString("base64")}`,
    );
    expect(mockedGitLoad).not.toHaveBeenCalled();
    expect(JSON.parse(String(init?.body))).toEqual({
      title: "Fix auth",
      source: { branch: { name: "fix/auth" } },
      destination: { branch: { name: "main" } },
      close_source_branch: true,
    });
    expect(output["pull_request"]).toMatchObject({ id: 7, state: "open" });
  });

  it("renders a compact pipeline list", async () => {
    fetchMock.mockResolvedValue(response({ size: 1, values: [{
      uuid: "{12345678-abcd}",
      build_number: 12,
      state: { result: { name: "SUCCESSFUL" } },
      target: { ref_name: "main", commit: { hash: "abcdef1234567890" } },
      created_on: "2026-01-01T00:00:00Z",
    }] }));
    const output = await pipelineCommand(["list", "--fields", "commit"], ctx);
    expect((output["pipelines"] as unknown[])[0]).toMatchObject({
      build: 12,
      state: "successful",
      branch: "main",
      uuid: "{12345678-abcd}",
      commit: "abcdef123456",
    });
  });

  it("reports pipeline wall time, not build seconds", async () => {
    const raw = {
      uuid: "{ee14c0ee-f8d6-4f39-a26e-e2246e871244}",
      build_number: 113124,
      state: { result: { name: "SUCCESSFUL" } },
      target: { ref_name: "main", commit: { hash: "30fb5e80fbe294130977c7f4442739ee22a61952" } },
      duration_in_seconds: 1279,
      build_seconds_used: 731,
    };
    fetchMock.mockResolvedValue(response(raw));
    const viewed = await pipelineCommand(["view", "{ee14c0ee-f8d6-4f39-a26e-e2246e871244}"], ctx);
    expect(viewed["pipeline"]).toMatchObject({ duration_seconds: 1279 });

    fetchMock.mockResolvedValue(response({ size: 1, values: [raw] }));
    const listed = await pipelineCommand(["list", "--fields", "duration"], ctx);
    expect((listed["pipelines"] as unknown[])[0]).toMatchObject({ duration: 1279 });
  });

  it("keeps raw API requests on api.bitbucket.org", async () => {
    fetchMock.mockResolvedValue(response({ ok: true }));
    await apiCommand(["/repositories/{workspace}/{repo}"], ctx);
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.bitbucket.org/2.0/repositories/acme/widgets");
  });

  it("sends PR description updates as PUT JSON with the stored API credential", async () => {
    fetchMock.mockResolvedValue(response({ id: 42, description: "Updated safely" }));
    await apiCommand([
      "PUT",
      "/repositories/{workspace}/{repo}/pullrequests/42",
      "--field",
      "description=Updated safely",
    ], ctx);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://api.bitbucket.org/2.0/repositories/acme/widgets/pullrequests/42",
    );
    expect(init?.method).toBe("PUT");
    expect(init?.headers).toMatchObject({
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from("agent@example.com:test-token").toString("base64")}`,
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init?.body))).toEqual({ description: "Updated safely" });
  });

  it("preserves sanitized details when Bitbucket denies a PR description update", async () => {
    fetchMock.mockResolvedValue(response({
      error: {
        message: "Forbidden",
        detail: "Missing pull request write scope for agent@example.com with token test-token",
      },
    }, 403));

    let caught: unknown;
    try {
      await apiCommand([
        "PUT",
        "/repositories/{workspace}/{repo}/pullrequests/42",
        "--field",
        "description=Updated safely",
      ], ctx);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: "PERMISSION_ERROR" });
    const message = (caught as Error).message;
    expect(message).toContain("Missing pull request write scope");
    expect(message).not.toContain("agent@example.com");
    expect(message).not.toContain("test-token");
  });

  it("home reveals the total when the dashboard preview is truncated", async () => {
    fetchMock.mockImplementation((url) => {
      const u = String(url);
      if (u.endsWith("repositories/acme/widgets")) return Promise.resolve(response({ full_name: "acme/widgets" }));
      if (u.includes("/pullrequests?")) return Promise.resolve(response({ size: 50, values: [
        { id: 1, title: "a", state: "OPEN", author: { display_name: "A" } },
        { id: 2, title: "b", state: "OPEN", author: { display_name: "B" } },
        { id: 3, title: "c", state: "OPEN", author: { display_name: "C" } },
      ] }));
      if (u.includes("/pipelines?")) return Promise.resolve(response({ size: 12, values: [{
        uuid: "{1}", build_number: 1, state: { result: { name: "SUCCESSFUL" } },
        target: { ref_name: "main", commit: { hash: "x" } },
      }] }));
      return Promise.resolve(response({}));
    });
    const toon = encode(await homeCommand([], ctx));
    expect(toon).toContain("open_pull_requests[3]");
    expect(toon).toContain("for all 50 open pull requests");
    expect(toon).toContain("for all 12 pipelines");
  });

  it("home omits the total hint and suggests creating when the preview is empty", async () => {
    fetchMock.mockImplementation((url) => {
      const u = String(url);
      if (u.endsWith("repositories/acme/widgets")) return Promise.resolve(response({ full_name: "acme/widgets" }));
      if (u.includes("/pullrequests?")) return Promise.resolve(response({ size: 0, values: [] }));
      if (u.includes("/pipelines?")) return Promise.resolve(response({ size: 0, values: [] }));
      return Promise.resolve(response({}));
    });
    const toon = encode(await homeCommand([], ctx));
    expect(toon).not.toContain("for all");
    expect(toon).toContain("pr create");
    expect(toon).toContain("pipeline run");
  });

  it("home omits the total hint when every item fits the preview", async () => {
    fetchMock.mockImplementation((url) => {
      const u = String(url);
      if (u.endsWith("repositories/acme/widgets")) return Promise.resolve(response({ full_name: "acme/widgets" }));
      if (u.includes("/pullrequests?")) return Promise.resolve(response({ size: 2, values: [
        { id: 1, title: "a", state: "OPEN", author: { display_name: "A" } },
        { id: 2, title: "b", state: "OPEN", author: { display_name: "B" } },
      ] }));
      if (u.includes("/pipelines?")) return Promise.resolve(response({ size: 1, values: [{
        uuid: "{1}", build_number: 1, state: { result: { name: "SUCCESSFUL" } },
        target: { ref_name: "main", commit: { hash: "x" } },
      }] }));
      return Promise.resolve(response({}));
    });
    const toon = encode(await homeCommand([], ctx));
    expect(toon).not.toContain("for all");
    expect(toon).toContain("pr list");
  });
});
