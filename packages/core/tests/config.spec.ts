import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadOperatorEnv, operatorEnvPath } from "../src/config.js";

const touched = ["HELIUM_PROXY", "HELIUM_CONFIG_PROBE", "HELIUM_ENV_FILE"];
afterEach(() => {
  for (const key of touched) delete process.env[key];
});

function envFile(body: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "helium-config-")), "helium.env");
  writeFileSync(path, body);
  return path;
}

describe("loadOperatorEnv", () => {
  it("fills the proxy from the file but never overwrites an explicit one", () => {
    // The precedence that matters: `HELIUM_PROXY=... helium run` must beat the
    // file, so a route can be tried without editing the operator's config.
    process.env.HELIUM_PROXY = "http://explicit:1";
    process.env.HELIUM_ENV_FILE = envFile(
      "HELIUM_PROXY=http://from-file:2\nHELIUM_CONFIG_PROBE=filled\n",
    );

    expect(loadOperatorEnv()).toBe(process.env.HELIUM_ENV_FILE);
    expect(process.env.HELIUM_PROXY).toBe("http://explicit:1");
    expect(process.env.HELIUM_CONFIG_PROBE).toBe("filled");
  });

  it("treats a missing file as normal, not as an error", () => {
    // A dev checkout has none, and every consumer reports the specific value it
    // could not find far more usefully than "no config file" would.
    process.env.HELIUM_ENV_FILE = join(tmpdir(), "helium-absent-config.env");
    expect(loadOperatorEnv()).toBeUndefined();
  });

  it("defaults to the path the launchd job and the v1 wrapper already use", () => {
    expect(operatorEnvPath({})).toMatch(/\/\.config\/helium\/helium\.env$/);
  });
});
