import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encode } from "@toon-format/toon";
import { AxiError } from "axi-sdk-js";

// Shared in-memory keyring mock. Tests reset and reprogram these per case so the
// real OS credential store is never touched.
const keyring = vi.hoisted(() => ({
  getPassword: vi.fn(),
  setPassword: vi.fn(),
  deleteCredential: vi.fn(),
}));

vi.mock("@napi-rs/keyring", () => ({
  Entry: vi.fn(() => keyring),
}));

// The credential module probes macOS `security` to tell a locked keychain from an
// absent entry. Every test drives that probe explicitly so the real keychain and
// its lock state are never consulted.
const childProcess = vi.hoisted(() => ({ spawnSync: vi.fn() }));

vi.mock("node:child_process", () => childProcess);

import { basicAuthHeader, bitbucketRequest, validateCredentials } from "../src/client.js";
import { configClear, configSet, configStatus, readTokenFromStdin } from "../src/commands/index.js";
import { clearCredentials, loadCredentials, saveCredentials } from "../src/credentials.js";

function response(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stdinInput(value: string): PassThrough {
  const input = new PassThrough();
  input.end(value);
  return input;
}

function probe(said: "unlocked" | "locked"): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const path = "<home>/Library/Keychains/login.keychain-db";
  return said === "locked"
    ? { status: 36, stdout: "", stderr: `security: SecKeychainCopySettings "${path}": User interaction is not allowed.\n` }
    : { status: 0, stdout: `Keychain "${path}" no-timeout\n`, stderr: "" };
}

const realPlatform = process.platform;

function stubPlatform(platform: string): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

beforeEach(() => {
  childProcess.spawnSync.mockReset();
  childProcess.spawnSync.mockReturnValue(probe("unlocked"));
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
});

// Stands in for a terminal: bytes arriving while raw mode is off are echoed to the
// visible transcript by the tty driver, and not while raw mode is on.
class EchoingTerminal extends PassThrough {
  isTTY = true;
  raw = false;

  constructor(private readonly transcript: PassThrough) {
    super();
  }

  setRawMode(mode: boolean): this {
    this.raw = mode;
    return this;
  }

  // The echo decision happens at the instant the bytes arrive, before any reader
  // sees them; delivery to the prompt is deferred so a pending question can attach.
  paste(text: string): void {
    if (!this.raw) this.transcript.write(text);
    setImmediate(() => this.push(text));
  }
}

function terminalInput(
  answers: Array<[prompt: string, answer: string]>,
  output: PassThrough,
): PassThrough {
  const input = new PassThrough();
  Object.assign(input, { isTTY: true });
  Object.assign(output, { isTTY: true });
  let transcript = "";
  let next = 0;
  output.on("data", (chunk) => {
    transcript += chunk.toString();
    const answer = answers[next];
    if (answer && transcript.includes(answer[0])) {
      next++;
      setImmediate(() => input.write(`${answer[1]}\n`));
    }
  });
  return input;
}

describe("credential store", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    keyring.getPassword.mockReset();
    keyring.setPassword.mockReset();
    keyring.deleteCredential.mockReset();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("returns null when no credential is stored", () => {
    keyring.getPassword.mockReturnValue(null);
    expect(loadCredentials()).toBeNull();
  });

  it("returns null when the keyring reports a missing entry", () => {
    keyring.getPassword.mockImplementation(() => {
      throw new Error("No matching entry found");
    });
    expect(loadCredentials()).toBeNull();
  });

  it("returns null for a malformed stored entry instead of throwing", () => {
    keyring.getPassword.mockReturnValue("not-json");
    expect(loadCredentials()).toBeNull();
  });

  it("loads a stored email and token", () => {
    keyring.getPassword.mockReturnValue(JSON.stringify({ email: "you@example.com", token: "secret-token" }));
    expect(loadCredentials()).toEqual({ email: "you@example.com", token: "secret-token" });
  });

  it("stores both values as a single keychain entry", () => {
    saveCredentials({ email: "you@example.com", token: "secret-token" });
    expect(keyring.setPassword).toHaveBeenCalledWith(
      JSON.stringify({ email: "you@example.com", token: "secret-token" }),
    );
  });

  it("translates a keyring failure into a structured error without leaking the native error", () => {
    keyring.setPassword.mockImplementation(() => {
      throw new Error("secret-service: D-Bus connection failed\n    at native/stack.ts:1:1");
    });
    let caught: unknown;
    try {
      saveCredentials({ email: "you@example.com", token: "secret-token" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AxiError);
    expect((caught as AxiError).message).toBe("Could not access the operating system credential store");
    expect((caught as AxiError).code).toBe("CREDENTIAL_STORE_ERROR");
    expect((caught as AxiError).message).not.toContain("secret-service");
    expect((caught as AxiError).message).not.toContain("D-Bus");
    expect((caught as Error).stack ?? "").not.toContain("secret-token");
  });

  it("clearCredentials is idempotent when the entry is already absent", () => {
    keyring.deleteCredential.mockReturnValue(false);
    expect(() => clearCredentials()).not.toThrow();
    expect(keyring.deleteCredential).toHaveBeenCalled();
  });

  it("clearCredentials treats a NoEntry-style throw as success", () => {
    keyring.deleteCredential.mockImplementation(() => {
      throw new Error("No matching entry found");
    });
    expect(() => clearCredentials()).not.toThrow();
  });
});

describe("missing credentials prevent fetch", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    keyring.getPassword.mockReset();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("makes no API call when no credential is stored", async () => {
    keyring.getPassword.mockReturnValue(null);
    await expect(bitbucketRequest("user")).rejects.toThrow("Bitbucket authentication is not configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("config set", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    keyring.setPassword.mockReset();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("validates the token and stores the credential in the keychain", async () => {
    fetchMock.mockResolvedValue(response({ values: [{ email: "you@example.com", is_primary: true }] }));
    const output = await configSet(
      ["--email", "you@example.com", "--token-stdin"],
      { stdin: stdinInput("secret-token") },
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.bitbucket.org/2.0/user/emails",
      expect.objectContaining({ method: "GET" }),
    );
    expect(keyring.setPassword).toHaveBeenCalledWith(
      JSON.stringify({ email: "you@example.com", token: "secret-token" }),
    );
    expect(output).toMatchObject({ config: { email: "you@example.com", status: "configured" } });
    expect(encode(output)).not.toContain("secret-token");
  });

  it("does not store the credential when Bitbucket rejects the token", async () => {
    fetchMock.mockResolvedValue(response({ error: { message: "bad credentials" } }, 401));
    await expect(
      configSet(["--email", "you@example.com", "--token-stdin"], { stdin: stdinInput("bad-token") }),
    ).rejects.toThrow("Bitbucket rejected the email or API token");
    expect(keyring.setPassword).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not store the credential when the email does not match the account", async () => {
    fetchMock.mockResolvedValue(response({ values: [{ email: "someone-else@example.com" }] }));
    await expect(
      configSet(["--email", "you@example.com", "--token-stdin"], { stdin: stdinInput("tok") }),
    ).rejects.toThrow("does not belong to this API token's account");
    expect(keyring.setPassword).not.toHaveBeenCalled();
  });

  it("collects a missing email and hidden token interactively", async () => {
    fetchMock.mockResolvedValue(response({ values: [{ email: "you@example.com", is_primary: true }] }));
    const stderr = new PassThrough();
    let prompts = "";
    stderr.on("data", (chunk) => { prompts += chunk.toString(); });
    const stdin = terminalInput([
      ["Atlassian account email:", "you@example.com"],
      ["Bitbucket API token:", "secret-token"],
    ], stderr);

    const output = await configSet([], { stdin, stderr });

    expect(output).toMatchObject({ config: { email: "you@example.com", status: "configured" } });
    expect(prompts).toContain("Atlassian account email:");
    expect(prompts).toContain("Bitbucket API token:");
    expect(prompts).not.toContain("secret-token");
  });

  it("skips the email prompt when --email is supplied", async () => {
    fetchMock.mockResolvedValue(response({ values: [{ email: "you@example.com" }] }));
    const stderr = new PassThrough();
    let prompts = "";
    stderr.on("data", (chunk) => { prompts += chunk.toString(); });
    const stdin = terminalInput([["Bitbucket API token:", "secret-token"]], stderr);

    await configSet(["--email", "you@example.com"], { stdin, stderr });

    expect(prompts).not.toContain("Atlassian account email:");
    expect(prompts).toContain("Bitbucket API token:");
    expect(prompts).not.toContain("secret-token");
  });

  it("refuses non-interactive setup without --token-stdin", async () => {
    await expect(configSet([], { stdin: new PassThrough(), stderr: new PassThrough() }))
      .rejects.toThrow("interactive setup requires a terminal");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(keyring.setPassword).not.toHaveBeenCalled();
  });

  it("keeps --email required for --token-stdin automation", async () => {
    await expect(configSet(["--token-stdin"], { stdin: stdinInput("secret-token") }))
      .rejects.toThrow("--email is required");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(keyring.setPassword).not.toHaveBeenCalled();
  });

  it("fails clearly when the token read from stdin is empty", async () => {
    await expect(
      configSet(["--email", "you@example.com", "--token-stdin"], { stdin: stdinInput("") }),
    ).rejects.toThrow("no API token received on stdin");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(keyring.setPassword).not.toHaveBeenCalled();
  });

  it("rejects an invalid email before any network or storage call", async () => {
    await expect(
      configSet(["--email", "not-an-email", "--token-stdin"], { stdin: stdinInput("tok") }),
    ).rejects.toThrow("invalid email");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(keyring.setPassword).not.toHaveBeenCalled();
  });

  it("rejects a token on stdin that exceeds the bounded size", async () => {
    const stream = new PassThrough();
    stream.end(Buffer.alloc(9000, 97)); // 9000 'a' bytes > 8192 limit
    await expect(readTokenFromStdin(stream)).rejects.toThrow("too large");
  });
});

describe("config status", () => {
  beforeEach(() => keyring.getPassword.mockReset());

  it("reports the configured email and readiness, never the token", async () => {
    keyring.getPassword.mockReturnValue(JSON.stringify({ email: "you@example.com", token: "secret-token" }));
    const toon = encode(await configStatus([]));
    expect(toon).toContain("you@example.com");
    expect(toon).toContain("ready: true");
    expect(toon).not.toContain("secret-token");
  });

  it("reports not ready when no credential is configured", async () => {
    keyring.getPassword.mockReturnValue(null);
    const toon = encode(await configStatus([]));
    expect(toon).toContain("ready: false");
    expect(toon).not.toContain("you@example.com");
    expect(toon).toContain("config set");
  });
});

describe("config clear", () => {
  beforeEach(() => {
    keyring.getPassword.mockReset();
    keyring.deleteCredential.mockReset();
  });

  it("removes a stored credential", async () => {
    keyring.getPassword.mockReturnValue(JSON.stringify({ email: "you@example.com", token: "tok" }));
    keyring.deleteCredential.mockReturnValue(true);
    const output = await configClear([]);
    expect(output).toMatchObject({ config: { status: "cleared" } });
    expect(keyring.deleteCredential).toHaveBeenCalled();
  });

  it("is idempotent when the store is already empty", async () => {
    keyring.getPassword.mockReturnValue(null);
    keyring.deleteCredential.mockReturnValue(false);
    const output = await configClear([]);
    expect(output).toMatchObject({ config: { status: "already clear" } });
  });
});

describe("locked credential store", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    keyring.getPassword.mockReset();
    keyring.setPassword.mockReset();
    stubPlatform("darwin");
  });

  afterEach(() => vi.unstubAllGlobals());

  it("reports a locked keychain as an unlocked store, not as a missing credential", () => {
    keyring.getPassword.mockReturnValue(null);
    childProcess.spawnSync.mockReturnValue(probe("locked"));

    let caught: unknown;
    try {
      loadCredentials();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AxiError);
    expect((caught as AxiError).code).toBe("CREDENTIAL_STORE_ERROR");
    expect((caught as AxiError).message).not.toContain("not configured");
    const help = (caught as AxiError).suggestions.join("\n");
    expect(help).toContain("security unlock-keychain ~/Library/Keychains/login.keychain-db");
    expect(help).toContain("without -p or -u");
    expect(childProcess.spawnSync).toHaveBeenCalledWith(
      "security",
      ["show-keychain-info", expect.stringContaining("login.keychain-db")],
      expect.objectContaining({ timeout: 2000 }),
    );
  });

  it("keeps a genuinely absent credential absent on an unlocked keychain", async () => {
    keyring.getPassword.mockReturnValue(null);
    childProcess.spawnSync.mockReturnValue(probe("unlocked"));

    expect(loadCredentials()).toBeNull();
    const toon = encode(await configStatus([]));
    expect(toon).toContain("ready: false");
    expect(toon).toContain("config set");
  });

  it("does not probe or fail when the credential is readable", () => {
    keyring.getPassword.mockReturnValue(JSON.stringify({ email: "you@example.com", token: "secret-token" }));
    expect(loadCredentials()).toEqual({ email: "you@example.com", token: "secret-token" });
    expect(childProcess.spawnSync).not.toHaveBeenCalled();
  });

  it("guides an unlock when the store throws an interaction error on read", () => {
    keyring.getPassword.mockImplementation(() => {
      throw new Error("Platform failure: User interaction is not allowed.");
    });
    expect(() => loadCredentials()).toThrow(/login keychain is locked/);
    expect(childProcess.spawnSync).not.toHaveBeenCalled();
  });

  it("guides an unlock when the store throws an interaction error on write", () => {
    keyring.setPassword.mockImplementation(() => {
      throw new Error("Platform failure: User interaction is not allowed.");
    });
    let caught: unknown;
    try {
      saveCredentials({ email: "you@example.com", token: "secret-token" });
    } catch (error) {
      caught = error;
    }
    expect((caught as AxiError).code).toBe("CREDENTIAL_STORE_ERROR");
    expect((caught as AxiError).suggestions.join("\n")).toContain("security unlock-keychain");
  });

  it("keeps an unrelated store failure generic instead of claiming a lock", () => {
    keyring.getPassword.mockImplementation(() => {
      throw new Error("secret-service: D-Bus connection failed");
    });
    let caught: unknown;
    try {
      loadCredentials();
    } catch (error) {
      caught = error;
    }
    expect((caught as AxiError).code).toBe("CREDENTIAL_STORE_ERROR");
    expect((caught as AxiError).message).toBe("Could not access the operating system credential store");
    expect((caught as AxiError).suggestions.join("\n")).not.toContain("unlock-keychain");
  });

  it("does not probe on platforms without the macOS keychain probe", () => {
    stubPlatform("linux");
    keyring.getPassword.mockReturnValue(null);
    expect(loadCredentials()).toBeNull();
    expect(childProcess.spawnSync).not.toHaveBeenCalled();
  });

  it("makes no API call and reports the locked store", async () => {
    keyring.getPassword.mockReturnValue(null);
    childProcess.spawnSync.mockReturnValue(probe("locked"));
    await expect(bitbucketRequest("user")).rejects.toThrow(/login keychain is locked/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function echoProtectedSet(
  answers: Array<[prompt: string, answer: string]>,
): { stdin: EchoingTerminal; stderr: PassThrough; transcript: () => string } {
  const stderr = new PassThrough();
  Object.assign(stderr, { isTTY: true });
  const stdin = new EchoingTerminal(stderr);
  let seen = "";
  let next = 0;
  stderr.on("data", (chunk) => {
    seen += chunk.toString();
    const answer = answers[next];
    // Answer inside the prompt write itself: the tightest paste race no human can beat.
    if (answer && seen.includes(answer[0])) {
      next++;
      stdin.paste(`${answer[1]}\n`);
    }
  });
  return { stdin, stderr, transcript: () => seen };
}

describe("hidden token prompt", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    keyring.setPassword.mockReset();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("never echoes a token pasted the instant the prompt appears", async () => {
    fetchMock.mockResolvedValue(response({ values: [{ email: "you@example.com", is_primary: true }] }));
    const { stdin, stderr, transcript } = echoProtectedSet([
      ["Bitbucket API token:", "secret-token"],
    ]);

    const output = await configSet(["--email", "you@example.com"], { stdin, stderr });

    expect(transcript()).toContain("Bitbucket API token:");
    expect(transcript()).not.toContain("secret-token");
    expect(keyring.setPassword).toHaveBeenCalledWith(
      JSON.stringify({ email: "you@example.com", token: "secret-token" }),
    );
    expect(output).toMatchObject({ config: { status: "configured" } });
  });

  it("restores the terminal and closes the prompt line after a failed validation", async () => {
    fetchMock.mockResolvedValue(response({ error: { message: "bad credentials" } }, 401));
    const { stdin, stderr, transcript } = echoProtectedSet([
      ["Bitbucket API token:", "bad-token"],
    ]);

    await expect(configSet(["--email", "you@example.com"], { stdin, stderr })).rejects.toThrow(
      "Bitbucket rejected the email or API token",
    );

    expect(stdin.raw).toBe(false);
    expect(transcript()).not.toContain("bad-token");
    expect(transcript().endsWith("\n")).toBe(true);
    expect(keyring.setPassword).not.toHaveBeenCalled();
  });

  it("leaves the terminal untouched for --token-stdin automation", async () => {
    fetchMock.mockResolvedValue(response({ values: [{ email: "you@example.com" }] }));
    const stderr = new PassThrough();
    Object.assign(stderr, { isTTY: true });
    const stdin = new EchoingTerminal(stderr);
    let prompts = "";
    stderr.on("data", (chunk) => { prompts += chunk.toString(); });

    const output = await configSet(["--email", "you@example.com", "--token-stdin"], {
      stdin: stdinInput("piped-token"),
      stderr,
    });

    expect(output).toMatchObject({ config: { status: "configured" } });
    expect(prompts).toBe("");
    expect(keyring.setPassword).toHaveBeenCalledWith(
      JSON.stringify({ email: "you@example.com", token: "piped-token" }),
    );
  });
});

describe("credential validation", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("constructs the Basic auth header as email:token base64 and never leaks the token", async () => {
    fetchMock.mockResolvedValue(response({ values: [{ email: "you@example.com" }] }));
    await validateCredentials("you@example.com", "secret-token");
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      basicAuthHeader("you@example.com", "secret-token"),
    );
    expect((init.headers as Record<string, string>)["Authorization"]).toBe(
      `Basic ${Buffer.from("you@example.com:secret-token").toString("base64")}`,
    );
  });

  it("accepts a token whose account owns the email", async () => {
    fetchMock.mockResolvedValue(response({ values: [{ email: "You@Example.com", is_primary: true }] }));
    await expect(validateCredentials("you@example.com", "tok")).resolves.toBeUndefined();
  });

  it("rejects a 401 without leaking the token in the error", async () => {
    fetchMock.mockResolvedValue(response({ error: { message: "bad secret-token" } }, 401));
    let caught: unknown;
    try {
      await validateCredentials("you@example.com", "secret-token");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AxiError);
    expect((caught as AxiError).code).toBe("AUTH_ERROR");
    expect((caught as AxiError).message).not.toContain("secret-token");
  });

  it("reports a missing scope on 403 with an actionable suggestion", async () => {
    fetchMock.mockResolvedValue(response({ error: { message: "forbidden" } }, 403));
    await expect(validateCredentials("you@example.com", "tok")).rejects.toThrow("lacks the scope");
  });

  it("basicAuthHeader encodes email:token as base64", () => {
    expect(basicAuthHeader("you@example.com", "secret-token")).toBe(
      `Basic ${Buffer.from("you@example.com:secret-token").toString("base64")}`,
    );
  });
});
