import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encode } from "@toon-format/toon";

// Account-aware keyring mock: the API entry and the Git entry are separate
// in-memory objects so the real OS credential store is never touched and the
// two entries do not bleed into each other.
const apiKeyring = vi.hoisted(() => ({
  getPassword: vi.fn(),
  setPassword: vi.fn(),
  deleteCredential: vi.fn(),
}));
const gitKeyring = vi.hoisted(() => ({
  getPassword: vi.fn(),
  setPassword: vi.fn(),
  deleteCredential: vi.fn(),
}));

vi.mock("@napi-rs/keyring", () => ({
  Entry: vi.fn((_service: string, account: string) =>
    account === "bitbucket-cloud-git" ? gitKeyring : apiKeyring,
  ),
}));

// An empty read makes the credential module probe macOS `security` for a locked
// keychain. Pin that probe to "unlocked" so no test ever consults the real one.
vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: "Keychain no-timeout\n", stderr: "" })),
}));

import {
  configGit,
  configGitClear,
  configGitSet,
  configGitStatus,
  credentialHelperCommand,
} from "../src/commands/index.js";
import { main } from "../src/cli.js";

function response(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stdin(text: string): NodeJS.ReadableStream {
  const stream = new PassThrough();
  stream.end(text);
  return stream;
}

const API_CREDS = JSON.stringify({ email: "you@example.com", token: "api-token" });

describe("config git set", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    apiKeyring.getPassword.mockReset();
    apiKeyring.setPassword.mockReset();
    gitKeyring.getPassword.mockReset();
    gitKeyring.setPassword.mockReset();
    apiKeyring.getPassword.mockReturnValue(API_CREDS);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("validates the Git token against the configured account email and stores it separately", async () => {
    fetchMock.mockResolvedValue(response({ values: [{ email: "you@example.com", is_primary: true }] }));
    const output = await configGitSet(["--token-stdin"], async () => "git-token");

    // Validated against the API account email, not a separate one.
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.bitbucket.org/2.0/user/emails",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from("you@example.com:git-token").toString("base64")}`,
        }),
      }),
    );
    // Stored in the Git keychain entry, not the API entry.
    expect(gitKeyring.setPassword).toHaveBeenCalledWith(
      JSON.stringify({ email: "you@example.com", token: "git-token" }),
    );
    expect(apiKeyring.setPassword).not.toHaveBeenCalled();
    expect(output).toMatchObject({ config: { git: "configured", email: "you@example.com" } });
    expect(encode(output)).not.toContain("git-token");
  });

  it("requires API credentials to be configured first", async () => {
    apiKeyring.getPassword.mockReturnValue(null);
    await expect(configGitSet(["--token-stdin"], async () => "tok")).rejects.toThrow(
      "API credentials are not configured",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(gitKeyring.setPassword).not.toHaveBeenCalled();
  });

  it("does not store the Git token when Bitbucket rejects it", async () => {
    fetchMock.mockResolvedValue(response({ error: { message: "bad credentials" } }, 401));
    await expect(configGitSet(["--token-stdin"], async () => "bad-token")).rejects.toThrow(
      "Bitbucket rejected the email or API token",
    );
    expect(gitKeyring.setPassword).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not store the Git token when it does not match the account", async () => {
    fetchMock.mockResolvedValue(response({ values: [{ email: "someone-else@example.com" }] }));
    await expect(configGitSet(["--token-stdin"], async () => "tok")).rejects.toThrow(
      "does not belong to this API token's account",
    );
    expect(gitKeyring.setPassword).not.toHaveBeenCalled();
  });

  it("requires --token-stdin and never accepts the token as an argument", async () => {
    await expect(configGitSet([], async () => "tok")).rejects.toThrow("--token-stdin is required");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(gitKeyring.setPassword).not.toHaveBeenCalled();
  });

  it("fails clearly when the token read from stdin is empty", async () => {
    await expect(configGitSet(["--token-stdin"], async () => "")).rejects.toThrow(
      "no Git token received on stdin",
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(gitKeyring.setPassword).not.toHaveBeenCalled();
  });
});

describe("config git status", () => {
  beforeEach(() => gitKeyring.getPassword.mockReset());

  it("reports configured with the email, never the token", async () => {
    gitKeyring.getPassword.mockReturnValue(
      JSON.stringify({ email: "you@example.com", token: "git-tok" }),
    );
    const toon = encode(await configGitStatus([]));
    expect(toon).toContain("git: configured");
    expect(toon).toContain("you@example.com");
    expect(toon).not.toContain("git-tok");
  });

  it("reports not configured when no Git token is stored", async () => {
    gitKeyring.getPassword.mockReturnValue(null);
    const toon = encode(await configGitStatus([]));
    expect(toon).toContain("git: not configured");
    expect(toon).toContain("config git set --token-stdin");
  });
});

describe("config git clear", () => {
  beforeEach(() => {
    gitKeyring.getPassword.mockReset();
    gitKeyring.deleteCredential.mockReset();
    apiKeyring.deleteCredential.mockReset();
  });

  it("removes a stored Git token", async () => {
    gitKeyring.getPassword.mockReturnValue(
      JSON.stringify({ email: "you@example.com", token: "git-tok" }),
    );
    gitKeyring.deleteCredential.mockReturnValue(true);
    const output = await configGitClear([]);
    expect(output).toMatchObject({ config: { git: "cleared" } });
    expect(gitKeyring.deleteCredential).toHaveBeenCalled();
  });

  it("is idempotent when the Git store is already empty", async () => {
    gitKeyring.getPassword.mockReturnValue(null);
    gitKeyring.deleteCredential.mockReturnValue(false);
    const output = await configGitClear([]);
    expect(output).toMatchObject({ config: { git: "already clear" } });
  });

  it("does not touch the API credential entry", async () => {
    gitKeyring.getPassword.mockReturnValue(null);
    gitKeyring.deleteCredential.mockReturnValue(false);
    await configGitClear([]);
    expect(apiKeyring.deleteCredential).not.toHaveBeenCalled();
  });
});

describe("config git routing", () => {
  it("rejects an unknown git subcommand", async () => {
    await expect(configGit(["bogus"])).rejects.toThrow("unknown config git subcommand: bogus");
  });

  it("requires a git subcommand", async () => {
    await expect(configGit([])).rejects.toThrow("config git subcommand is required");
  });
});

describe("credential helper", () => {
  beforeEach(() => gitKeyring.getPassword.mockReset());

  it("emits username and password for a bitbucket.org get request", async () => {
    gitKeyring.getPassword.mockReturnValue(
      JSON.stringify({ email: "you@example.com", token: "git-tok" }),
    );
    const output = await credentialHelperCommand(
      ["get"],
      stdin("protocol=https\nhost=bitbucket.org\n\n"),
    );
    expect(output).toBe("username=you@example.com\npassword=git-tok");
  });

  it("parses the host from a url attribute when host is absent", async () => {
    gitKeyring.getPassword.mockReturnValue(
      JSON.stringify({ email: "you@example.com", token: "git-tok" }),
    );
    const output = await credentialHelperCommand(
      ["get"],
      stdin("url=https://bitbucket.org/acme/widgets.git\n\n"),
    );
    expect(output).toBe("username=you@example.com\npassword=git-tok");
  });

  it("returns nothing for a non-bitbucket host", async () => {
    gitKeyring.getPassword.mockReturnValue(
      JSON.stringify({ email: "you@example.com", token: "git-tok" }),
    );
    const output = await credentialHelperCommand(
      ["get"],
      stdin("protocol=https\nhost=github.com\n\n"),
    );
    expect(output).toBe("");
  });

  it("returns nothing when no Git token is configured", async () => {
    gitKeyring.getPassword.mockReturnValue(null);
    const output = await credentialHelperCommand(
      ["get"],
      stdin("protocol=https\nhost=bitbucket.org\n\n"),
    );
    expect(output).toBe("");
  });

  it("store and erase are no-ops that do not read credentials", async () => {
    gitKeyring.getPassword.mockReturnValue(
      JSON.stringify({ email: "you@example.com", token: "git-tok" }),
    );
    await expect(credentialHelperCommand(["store"], stdin("protocol=https\nhost=bitbucket.org\n\n"))).resolves.toBe("");
    await expect(credentialHelperCommand(["erase"], stdin("protocol=https\nhost=bitbucket.org\n\n"))).resolves.toBe("");
    // A read-only helper never inspects storage for store/erase.
    expect(gitKeyring.getPassword).not.toHaveBeenCalled();
  });
});

describe("credential helper (end-to-end via CLI)", () => {
  const originalStdin = process.stdin;
  let output = "";
  const stdout = { write: (chunk: string) => { output += chunk; } };

  beforeEach(() => {
    output = "";
    process.exitCode = undefined;
    gitKeyring.getPassword.mockReset();
  });

  afterEach(() => {
    process.exitCode = undefined;
    Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true });
  });

  it("outputs raw git protocol text (not TOON) for a bitbucket.org get request", async () => {
    gitKeyring.getPassword.mockReturnValue(
      JSON.stringify({ email: "you@example.com", token: "git-tok" }),
    );
    const fakeStdin = new PassThrough();
    Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true });
    fakeStdin.end("protocol=https\nhost=bitbucket.org\n\n");
    await main({ argv: ["credential-helper", "get"], stdout });
    // Raw protocol text with the SDK's trailing newline; never TOON-encoded.
    expect(output).toBe("username=you@example.com\npassword=git-tok\n");
  });

  it("outputs nothing for a non-bitbucket host through the CLI", async () => {
    gitKeyring.getPassword.mockReturnValue(
      JSON.stringify({ email: "you@example.com", token: "git-tok" }),
    );
    const fakeStdin = new PassThrough();
    Object.defineProperty(process, "stdin", { value: fakeStdin, configurable: true });
    fakeStdin.end("protocol=https\nhost=github.com\n\n");
    await main({ argv: ["credential-helper", "get"], stdout });
    expect(output).toBe("\n");
  });
});
