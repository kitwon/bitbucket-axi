import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, TOP_HELP } from "../src/cli.js";

// Credentials are mocked so the home view and command routing never touch the
// real OS keychain.
vi.mock("../src/credentials.js", () => ({
  loadCredentials: vi.fn(),
  saveCredentials: vi.fn(),
  clearCredentials: vi.fn(),
  isValidEmail: vi.fn(),
}));
import { loadCredentials } from "../src/credentials.js";
const mockedLoad = vi.mocked(loadCredentials);

describe("CLI", () => {
  const fetchMock = vi.fn<typeof fetch>();
  let output = "";
  const stdout = { write: (chunk: string) => { output += chunk; } };

  beforeEach(() => {
    output = "";
    process.exitCode = undefined;
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    mockedLoad.mockReset();
    mockedLoad.mockReturnValue(null);
  });

  afterEach(() => {
    process.exitCode = undefined;
    vi.unstubAllGlobals();
  });

  it("shows concise top-level help", async () => {
    await main({ argv: ["--help"], stdout });
    expect(output).toBe(TOP_HELP);
    expect(output).toContain("commands[6]");
    expect(output).toContain("config set|status|clear");
  });

  it("documents body files and exact description verification", async () => {
    await main({ argv: ["pr", "--help"], stdout });
    expect(output).toContain("--body-file <path>");
    expect(output).toContain("read back and must exactly equal");
    expect(output).toContain("list, view <id>, create, watch <id>");
    expect(output).toContain("pr watch 42 --interval 10 --timeout 1800");
    expect(output).toContain("0 passed, 1 failed/stopped/expired/unknown, 3 inconclusive");
    expect(output).toContain("8 still active");
    expect(output).toContain("130 interrupted");

    output = "";
    await main({ argv: ["api", "--help"], stdout });
    expect(output).toContain("--body-file <path>");
    expect(output).toContain("read back for exact equality");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prints the package version", async () => {
    await main({ argv: ["--version"], stdout });
    expect(output).toBe("0.1.0\n");
  });

  it("rejects unknown arguments before the network", async () => {
    mockedLoad.mockReturnValue({ email: "agent@example.com", token: "test-token" });
    await main({ argv: ["pr", "list", "--stat", "open", "-R", "acme/widgets"], stdout });
    expect(process.exitCode).toBe(2);
    expect(output).toContain("unknown flag --stat");
    expect(output).toContain("Valid flags:");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("formats invalid repository selectors without a stack trace", async () => {
    mockedLoad.mockReturnValue({ email: "agent@example.com", token: "test-token" });
    await main({ argv: ["repo", "view", "-R", "invalid"], stdout });
    expect(process.exitCode).toBe(2);
    expect(output).toContain("invalid repository: invalid");
    expect(output).not.toContain("AxiError");
    expect(output).not.toContain("at parseRepo");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders a no-argument home view without credentials", async () => {
    mockedLoad.mockReturnValue(null);
    await main({ argv: [], stdout });
    expect(output).toContain("bin:");
    expect(output).toContain("description:");
    expect(output).toMatch(/repository: (not detected|[^\n]+)/);
    expect(output).toContain("config set` in a terminal");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows config command help without credentials or repository context", async () => {
    mockedLoad.mockReturnValue(null);
    await main({ argv: ["config", "--help"], stdout });
    expect(output).toContain("bitbucket-axi config <subcommand>");
    expect(output).toContain("bitbucket-axi config set\n");
    expect(output).toContain("token-producing-command");
    expect(output).toContain("--token-stdin");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports config status without credentials", async () => {
    mockedLoad.mockReturnValue(null);
    await main({ argv: ["config", "status"], stdout });
    expect(process.exitCode).toBeUndefined();
    expect(output).toContain("ready: false");
    expect(output).toContain("config set` in a terminal");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses non-interactive config setup with structured guidance", async () => {
    await main({ argv: ["config", "set"], stdout });
    expect(process.exitCode).toBe(2);
    expect(output).toContain("interactive setup requires a terminal");
    expect(output).toContain("--token-stdin");
    expect(output).not.toContain("API token:");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown config subcommand", async () => {
    mockedLoad.mockReturnValue(null);
    await main({ argv: ["config", "bogus"], stdout });
    expect(process.exitCode).toBe(2);
    expect(output).toContain("unknown config subcommand: bogus");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown flag on a config subcommand", async () => {
    mockedLoad.mockReturnValue(null);
    await main({ argv: ["config", "status", "--bogus"], stdout });
    expect(process.exitCode).toBe(2);
    expect(output).toContain("unknown flag --bogus");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows credential-helper help without reading stdin or credentials", async () => {
    mockedLoad.mockReturnValue(null);
    await main({ argv: ["credential-helper", "--help"], stdout });
    expect(output).toContain("Git credential helper");
    expect(output).toContain("credential.helper");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a missing git subcommand under config", async () => {
    mockedLoad.mockReturnValue(null);
    await main({ argv: ["config", "git"], stdout });
    expect(process.exitCode).toBe(2);
    expect(output).toContain("config git subcommand is required");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
