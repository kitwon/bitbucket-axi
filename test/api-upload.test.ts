import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiCommand } from "../src/commands/index.js";
import type { RepoContext } from "../src/context.js";

// The credential module is mocked so these tests never touch the OS keychain.
vi.mock("../src/credentials.js", () => ({
  loadCredentials: vi.fn(),
  loadGitCredentials: vi.fn(),
  saveCredentials: vi.fn(),
  clearCredentials: vi.fn(),
  isValidEmail: vi.fn(),
}));
import { loadCredentials } from "../src/credentials.js";
const mockedLoad = vi.mocked(loadCredentials);

const ctx: RepoContext = { workspace: "acme", repo: "widgets", nwo: "acme/widgets", source: "flag" };

// A tiny PNG: the leading bytes are not valid UTF-8, so a text round trip would
// corrupt them and this test would catch it.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x7f]);

describe("api --file uploads", () => {
  const fetchMock = vi.fn<typeof fetch>();
  let dir = "";

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    mockedLoad.mockReset();
    mockedLoad.mockReturnValue({ email: "agent@example.com", token: "test-token" });
    dir = mkdtempSync(join(tmpdir(), "bb-axi-upload-"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  function imageAt(name: string): string {
    const sub = join(dir, "nested");
    mkdirSync(sub, { recursive: true });
    const path = join(sub, name);
    writeFileSync(path, PNG_BYTES);
    return path;
  }

  it("posts multipart/form-data with the exact file bytes", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 201 }));
    const path = imageAt("screenshot.png");

    await apiCommand(
      ["POST", "/repositories/{workspace}/{repo}/downloads", "--file", `files=${path}`],
      ctx,
    );

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.bitbucket.org/2.0/repositories/acme/widgets/downloads");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Basic /);
    // fetch sets the multipart boundary itself; a JSON Content-Type would break it.
    expect(headers["Content-Type"]).toBeUndefined();

    const form = init?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const part = form.get("files") as File;
    expect(part.name).toBe("screenshot.png");
    expect(Buffer.from(await part.arrayBuffer()).equals(PNG_BYTES)).toBe(true);
  });

  it("sends only the base name, never the local path", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 201 }));
    const path = imageAt("shot.png");
    await apiCommand(["POST", "/repositories/{workspace}/{repo}/downloads", "--file", `files=${path}`], ctx);
    const form = fetchMock.mock.calls[0]![1]?.body as FormData;
    const part = form.get("files") as File;
    expect(part.name).toBe("shot.png");
    expect(part.name).not.toContain(dir);
  });

  it("rejects an unreadable file before calling Bitbucket", async () => {
    await expect(
      apiCommand(["POST", "/repositories/{workspace}/{repo}/downloads", "--file", `files=${join(dir, "missing.png")}`], ctx),
    ).rejects.toThrow("cannot read upload file");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects uploads on read-only methods", async () => {
    const path = imageAt("shot.png");
    await expect(
      apiCommand(["GET", "/repositories/{workspace}/{repo}/downloads", "--file", `files=${path}`], ctx),
    ).rejects.toThrow("--file requires POST, PUT, or PATCH");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects mixing --file with --field", async () => {
    const path = imageAt("shot.png");
    await expect(
      apiCommand(
        ["POST", "/repositories/{workspace}/{repo}/downloads", "--file", `files=${path}`, "--field", "name=x"],
        ctx,
      ),
    ).rejects.toThrow("--file cannot be combined with --field");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a malformed --file value", async () => {
    await expect(
      apiCommand(["POST", "/repositories/{workspace}/{repo}/downloads", "--file", "files"], ctx),
    ).rejects.toThrow("invalid --file");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
