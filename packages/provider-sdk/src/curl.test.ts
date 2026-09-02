import { describe, expect, it } from "vitest";
import { curlPostJson } from "./curl.js";

/**
 * These are the properties the retired process-boundary contract used to prove
 * with a fake CLI. They now live here, next to the one process any provider
 * still starts.
 */
describe("curlPostJson", () => {
  it("keeps a secret out of argv and passes it through the environment", async () => {
    // `ps` is readable by every local user, so a token in argv is a token
    // disclosed. curl expands `{{VAR}}` itself from an env variable.
    const seen = await capture({
      url: "https://example.invalid/",
      headers: { "content-type": "application/json" },
      secretHeaders: {
        authorization: { prefix: "Bearer ", value: "sk-ant-oat01-SECRET" },
      },
      body: "{}",
      timeoutMs: 1_000,
    });

    expect(seen.argv.join(" ")).not.toContain("sk-ant-oat01-SECRET");
    expect(seen.argv).toContain("--expand-header");
    expect(Object.values(seen.env)).toContain("sk-ant-oat01-SECRET");
    const varName = Object.entries(seen.env).find(
      ([, v]) => v === "sk-ant-oat01-SECRET",
    )?.[0];
    expect(varName).toBeDefined();
    expect(seen.argv).toContain(`authorization: Bearer {{${String(varName)}}}`);
  });

  it("leaks no ambient variable into curl's environment", async () => {
    // The mini ran unproxied for months because an ambient https_proxy was
    // absent under launchd while present in a shell. Inheriting the ambient
    // environment is what made that difference invisible, so we inherit none.
    // (macOS injects __CF_USER_TEXT_ENCODING into every child regardless.)
    process.env.HELIUM_AMBIENT_CANARY = "must-not-propagate";
    try {
      const seen = await capture({
        url: "https://example.invalid/",
        headers: {},
        body: "{}",
        timeoutMs: 1_000,
      });
      expect(seen.env.HELIUM_AMBIENT_CANARY).toBeUndefined();
      expect(
        Object.keys(seen.env).filter((k) => /proxy/i.test(k)),
      ).toEqual([]);
      expect(seen.env.PATH).toBeUndefined();
    } finally {
      delete process.env.HELIUM_AMBIENT_CANARY;
    }
  });

  it("passes an explicit proxy and omits the flag when none is declared", async () => {
    const withProxy = await capture({
      url: "https://example.invalid/",
      headers: {},
      body: "{}",
      timeoutMs: 1_000,
      proxy: "http://127.0.0.1:7897",
    });
    expect(withProxy.argv).toContain("--proxy");
    expect(withProxy.argv).toContain("http://127.0.0.1:7897");

    const without = await capture({
      url: "https://example.invalid/",
      headers: {},
      body: "{}",
      timeoutMs: 1_000,
    });
    expect(without.argv).not.toContain("--proxy");
  });

  it("reports an unreachable host as a transport failure, not a status", async () => {
    const res = await curlPostJson({
      url: "https://example.invalid/",
      headers: {},
      body: "{}",
      timeoutMs: 5_000,
    });
    expect(res.terminal).toBe("transport");
    expect(res.status).toBe(0);
  });

  it("separates the body from the status curl appends", async () => {
    // A body ending in something status-shaped must not truncate the payload.
    const res = await curlPostJson({
      url: "https://example.invalid/",
      headers: {},
      body: "{}",
      timeoutMs: 5_000,
    });
    expect(res.body).not.toContain("HELIUM_STATUS");
  });
});

/**
 * Runs the real helper against a `curl` shim earlier on PATH that records what
 * it was given. Nothing leaves the machine.
 */
async function capture(
  req: Parameters<typeof curlPostJson>[0],
): Promise<{ argv: string[]; env: Record<string, string> }> {
  const { mkdtempSync, writeFileSync, chmodSync, readFileSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const dir = mkdtempSync(join(tmpdir(), "helium-curl-"));
  const log = join(dir, "seen.json");
  const shim = join(dir, "curl");
  // Absolute interpreter: the child gets no PATH, so `/usr/bin/env node` would
  // not resolve — the same trap the production spawn relies on deliberately.
  writeFileSync(
    shim,
    `#!${process.execPath}
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({
  argv: process.argv.slice(2),
  env: process.env,
}));
process.stdout.write("{}\\nHELIUM_STATUS:200");
`,
  );
  chmodSync(shim, 0o755);

  const original = process.env.HELIUM_CURL_BIN;
  process.env.HELIUM_CURL_BIN = shim;
  try {
    await curlPostJson(req);
  } finally {
    if (original === undefined) delete process.env.HELIUM_CURL_BIN;
    else process.env.HELIUM_CURL_BIN = original;
  }
  return JSON.parse(readFileSync(log, "utf8")) as {
    argv: string[];
    env: Record<string, string>;
  };
}
