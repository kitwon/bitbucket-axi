import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiCommand, prCommand } from "../src/commands/index.js";
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
const DOWNLOADS = "https://bitbucket.org/acme/widgets/downloads";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);

// A description mutation is the only call these tests care about, so the stored
// downloads behind each reference are declared per test.
type Stored = { contentType: string; bytes: Uint8Array } | number;

function image(name: string): string {
  return `https://bitbucket.org/acme/widgets/downloads/${name}`;
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("PR body image precheck", () => {
  const fetchMock = vi.fn<typeof fetch>();
  let stored: Map<string, Stored>;
  let requests: string[];
  let mutations: Record<string, unknown>[];

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    mockedLoad.mockReset();
    mockedLoad.mockReturnValue({ email: "agent@example.com", token: "test-token" });
    stored = new Map();
    requests = [];
    mutations = [];

    fetchMock.mockImplementation((input, init) => {
      const url = new URL(String(input));
      const method = (init?.method ?? "GET").toUpperCase();
      requests.push(`${method} ${url.pathname}`);

      if (url.origin === "https://api.bitbucket.org" && url.pathname.includes("/downloads/")) {
        const name = decodeURIComponent(url.pathname.split("/downloads/")[1]!);
        const file = stored.get(name);
        if (file === undefined) return Promise.resolve(response({ error: { message: "Not found" } }, 404));
        if (typeof file === "number") return Promise.resolve(response({ error: { message: "boom" } }, file));
        return Promise.resolve(
          new Response(file.bytes, { status: 200, headers: { "content-type": file.contentType } }),
        );
      }
      if (method !== "GET") {
        mutations.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return Promise.resolve(response({ id: 42, description: "stored" }));
      }
      return Promise.resolve(response({ id: 42, description: "stored" }));
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function putDescription(description: string): Promise<void> {
    await apiCommand(
      ["PUT", "/repositories/{workspace}/{repo}/pullrequests/42", "--field", `description=${description}`],
      ctx,
    );
  }

  async function rejection(run: () => Promise<unknown>): Promise<{ message: string; code?: string; suggestions: string[] }> {
    const caught = await run().then(
      () => undefined,
      (error: unknown) => error as { message: string; code?: string; suggestions?: string[] },
    );
    expect(caught, "expected the command to fail").toBeDefined();
    return { message: caught!.message, code: caught!.code, suggestions: caught!.suggestions ?? [] };
  }

  it("sends a description with no image reference without reading a download", async () => {
    await putDescription("# Summary\n\nNo screenshots here.");
    expect(requests).toEqual(["PUT /2.0/repositories/acme/widgets/pullrequests/42"]);
    expect(mutations).toHaveLength(1);
  });

  it("sends a description whose images are all uploaded", async () => {
    stored.set("shot-desktop.png", { contentType: "image/png", bytes: PNG });
    stored.set("shot-mobile.png", { contentType: "image/png", bytes: PNG });
    const body = [
      "| surface | before |",
      "| -- | -- |",
      `| desktop | ![desktop](${image("shot-desktop.png")}) |`,
      `| mobile | ![mobile](${image("shot-mobile.png")}) |`,
    ].join("\n");

    await putDescription(body);

    expect(requests).toEqual([
      "GET /2.0/repositories/acme/widgets/downloads/shot-desktop.png",
      "GET /2.0/repositories/acme/widgets/downloads/shot-mobile.png",
      "PUT /2.0/repositories/acme/widgets/pullrequests/42",
    ]);
    expect(mutations[0]).toEqual({ description: body });
  });

  it("stops a body whose URL name differs from the uploaded file name", async () => {
    // The observed failure: the upload kept its source name while the body
    // referenced the intended body name, so every image was a permanent 404.
    stored.set("ss98-contact-userdeploy-desktop.png", { contentType: "image/png", bytes: PNG });
    const body = `| contact | ![contact](${image("sl-14319-ss98-contact-userdeploy-desktop.png")}) |`;

    const failed = await rejection(() => putDescription(body));

    expect(failed.code).toBe("VALIDATION_ERROR");
    expect(failed.message).toContain("1 image reference in the pull request body cannot be published");
    expect(failed.suggestions.join("\n")).toContain(
      "downloads/sl-14319-ss98-contact-userdeploy-desktop.png in acme/widgets does not exist",
    );
    expect(failed.suggestions.join("\n")).toContain(
      "--file files=<dir>/sl-14319-ss98-contact-userdeploy-desktop.png",
    );
    expect(mutations).toHaveLength(0);
  });

  it("accepts an upload stored without an image content type", async () => {
    // A real upload through this CLI stores application/octet-stream, so a
    // content-type gate on image/* would refuse every screenshot it uploaded.
    stored.set("shot.png", { contentType: "application/octet-stream", bytes: PNG });
    await putDescription(`![shot](${image("shot.png")})`);
    expect(mutations).toHaveLength(1);
  });

  it("stops a description that references an empty upload", async () => {
    stored.set("shot.png", { contentType: "image/png", bytes: new Uint8Array() });
    const failed = await rejection(() => putDescription(`![shot](${image("shot.png")})`));
    expect(failed.suggestions.join("\n")).toContain("downloads/shot.png in acme/widgets is an empty file");
    expect(mutations).toHaveLength(0);
  });

  it("stops a description that references a stored text file", async () => {
    stored.set("notes.md", { contentType: "text/markdown", bytes: new TextEncoder().encode("# notes") });
    const failed = await rejection(() => putDescription(`![shot](${image("notes.md")})`));
    expect(failed.suggestions.join("\n")).toContain("is text/markdown, not an image");
    expect(mutations).toHaveLength(0);
  });

  it("stops when the download read fails", async () => {
    stored.set("shot.png", 500);
    const failed = await rejection(() => putDescription(`![shot](${image("shot.png")})`));
    expect(failed.suggestions.join("\n")).toContain("could not be read");
    expect(mutations).toHaveLength(0);
  });

  it("rejects an image with an unclosed destination before any request", async () => {
    const failed = await rejection(() => putDescription(`![shot](${DOWNLOADS}/shot.png`));
    expect(failed.message).toBe("pull request body has invalid image syntax");
    expect(failed.suggestions).toContain('line 1: image has no closing ")"');
    expect(requests).toHaveLength(0);
  });

  it("rejects an image with an empty destination", async () => {
    const failed = await rejection(() => putDescription("![shot]()"));
    expect(failed.suggestions).toContain("line 1: image has an empty destination");
    expect(requests).toHaveLength(0);
  });

  it("rejects an unescaped pipe in table alt text and accepts an escaped one", async () => {
    stored.set("shot.png", { contentType: "image/png", bytes: PNG });
    const broken = await rejection(() =>
      putDescription(`| desktop | ![before|after](${image("shot.png")}) |`),
    );
    expect(broken.suggestions.join("\n")).toContain('unescaped "|" in a table row');

    await putDescription(`| desktop | ![before\\|after](${image("shot.png")}) |`);
    expect(mutations).toHaveLength(1);
  });

  it("rejects a glob name that would pass a downloads pattern read", async () => {
    const failed = await rejection(() => putDescription(`![shot](${image("shot*.png")})`));
    expect(failed.suggestions.join("\n")).toContain("image file name must be literal");
    expect(requests).toHaveLength(0);
  });

  it("ignores image syntax inside code spans and fenced blocks", async () => {
    const body = [
      'Write `![alt](' + image("shot.png") + ")` to reference a file.",
      "",
      "```md",
      `![alt](${image("missing.png")})`,
      "```",
    ].join("\n");

    await putDescription(body);

    expect(requests).toEqual(["PUT /2.0/repositories/acme/widgets/pullrequests/42"]);
    expect(mutations).toHaveLength(1);
  });

  it("leaves a non-Downloads image URL alone", async () => {
    await putDescription("![badge](https://img.shields.io/badge/build-passing.svg)");
    expect(requests).toEqual(["PUT /2.0/repositories/acme/widgets/pullrequests/42"]);
  });

  it("checks a body written by pr create", async () => {
    stored.set("ss98-contact.png", { contentType: "image/png", bytes: PNG });
    const body = `![contact](${image("sl-14319-contact.png")})`;

    const failed = await rejection(() =>
      prCommand(["create", "--title", "Shop evidence", "--source", "fix/x", "--body", body], ctx),
    );

    expect(failed.suggestions.join("\n")).toContain("does not exist");
    expect(requests).toEqual(["GET /2.0/repositories/acme/widgets/downloads/sl-14319-contact.png"]);
    expect(mutations).toHaveLength(0);
  });

  it("creates a pull request once its images are present", async () => {
    stored.set("contact.png", { contentType: "image/png", bytes: PNG });
    await prCommand(
      ["create", "--title", "Shop evidence", "--source", "fix/x", "--body", `![contact](${image("contact.png")})`],
      ctx,
    );
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toMatchObject({ description: `![contact](${image("contact.png")})` });
  });

  it("checks a description sent by an API pull request create", async () => {
    const body = `![contact](${image("missing.png")})`;
    const failed = await rejection(() =>
      apiCommand(["POST", "/repositories/{workspace}/{repo}/pullrequests", "--field", `description=${body}`], ctx),
    );
    expect(failed.message).toContain("cannot be published");
    expect(mutations).toHaveLength(0);
  });

  it("checks a description path written with the explicit 2.0 prefix", async () => {
    const body = `![contact](${image("missing.png")})`;
    const failed = await rejection(() =>
      apiCommand([
        "PUT",
        "/2.0/repositories/{workspace}/{repo}/pullrequests/42",
        "--field",
        `description=${body}`,
      ], ctx),
    );
    expect(failed.message).toContain("cannot be published");
    expect(mutations).toHaveLength(0);
  });

  it("does not check a mutation that leaves the description alone", async () => {
    await apiCommand(
      ["PUT", "/repositories/{workspace}/{repo}/pullrequests/42", "--field", "title=Renamed"],
      ctx,
    );
    expect(requests).toEqual(["PUT /2.0/repositories/acme/widgets/pullrequests/42"]);
  });

  it("does not check a description outside the pull request body endpoints", async () => {
    await apiCommand(
      ["PUT", "/snippets/acme/1234", "--field", `description=![x](${image("missing.png")})`],
      ctx,
    );
    expect(requests).toEqual(["PUT /2.0/snippets/acme/1234"]);
  });

  it("does not check reads", async () => {
    await apiCommand(["GET", "/repositories/{workspace}/{repo}/pullrequests/42"], ctx);
    expect(requests).toEqual(["GET /2.0/repositories/acme/widgets/pullrequests/42"]);
  });
});
