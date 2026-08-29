import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandRunner } from "../probes/process.js";
import {
  composeObserveOnlyOpsDaemon,
  loadOpsdRuntimeConfig,
  parseOpsdArgs,
  writeBoundedOpsLog,
} from "./opsd.js";

const roots: string[] = [];
const releaseDir = fileURLToPath(new URL("../../../../", import.meta.url));
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("opsd executable boundary", () => {
  it("accepts one explicit config and rejects command-surface expansion", () => {
    expect(parseOpsdArgs(["--config", "/tmp/opsd.json"])).toEqual({
      configPath: "/tmp/opsd.json",
    });
    expect(() => parseOpsdArgs(["--config", "a", "--execute", "anything"]))
      .toThrow(/unknown opsd argument/);
    expect(() => parseOpsdArgs([])).toThrow(/requires --config/);
  });

  it("fails closed when the packaged runtime mode is elevated", () => {
    const root = mkdtempSync(join(tmpdir(), "helium-opsd-config-"));
    roots.push(root);
    const path = join(root, "opsd.json");
    const config = {
      version: 1,
      mode: "auto",
      releaseDir,
      componentsDir: "ops/components",
      dependenciesDir: "ops/dependencies",
      checksDir: "ops/checks",
      sopsDir: "ops/sops",
      executorsDir: "ops/executors",
      authorityManifestPath: `${releaseDir}/ops/authority-manifest.json`,
      trustedKeyPath: `${releaseDir}/ops/authority-manifest.pub.pem`,
      stateDir: `${root}/state`,
      socketPath: `${root}/run/opsd.sock`,
      intervalMs: 60000,
      maxFiles: 500,
      maxComponents: 200,
      maxSops: 200,
      maxChecks: 500,
      maxFileBytes: 1000000,
    };
    writeFileSync(path, JSON.stringify(config));
    expect(() => loadOpsdRuntimeConfig(path)).toThrow(/mode/);
  });

  it("starts a provider-free observe tick, persists observations, and stops cleanly", async () => {
    const root = mkdtempSync(join(tmpdir(), "helium-opsd-runtime-"));
    roots.push(root);
    let commands = 0;
    const runner: CommandRunner = {
      async run() {
        commands += 1;
        return {
          stdout: "unavailable in fixture",
          exitCode: 127,
          timedOut: false,
          evidenceRef: `artifact://fixture/raw/${commands}`,
        };
      },
    };
    const daemon = composeObserveOnlyOpsDaemon(
      {
        version: 1,
        mode: "observe",
        releaseDir,
        componentsDir: "ops/components",
        dependenciesDir: "ops/dependencies",
        checksDir: "ops/checks",
        sopsDir: "ops/sops",
        executorsDir: "ops/executors",
        // Missing authority is an observe downgrade, not a startup dependency.
        authorityManifestPath: `${root}/missing-authority-manifest.json`,
        trustedKeyPath: `${releaseDir}/ops/authority-manifest.pub.pem`,
        stateDir: `${root}/state`,
        socketPath: `${root}/run/opsd.sock`,
        intervalMs: 60000,
        maxFiles: 500,
        maxComponents: 200,
        maxSops: 200,
        maxChecks: 500,
        maxFileBytes: 1000000,
      },
      { runner },
    );

    await daemon.start();
    try {
      expect(commands).toBe(7);
      const log = readFileSync(join(root, "state", "events.jsonl"), "utf8");
      expect(log).toContain('"type":"observation-recorded"');
      expect(log).toContain('"componentId":"host"');
    } finally {
      await daemon.stop();
    }
  });

  it("keeps daemon-owned logs within their configured byte bound", () => {
    const root = mkdtempSync(join(tmpdir(), "helium-opsd-log-"));
    roots.push(root);
    const previous = process.env.HELIUM_OPSD_LOG_ROOT;
    process.env.HELIUM_OPSD_LOG_ROOT = root;
    try {
      for (let i = 0; i < 8; i += 1) {
        writeBoundedOpsLog("err", `${i}:${"x".repeat(50)}`, 128);
      }
      const path = join(root, "opsd.err.log");
      expect(statSync(path).size).toBeLessThanOrEqual(128);
      expect(readFileSync(path, "utf8")).toContain("7:");
    } finally {
      if (previous === undefined) delete process.env.HELIUM_OPSD_LOG_ROOT;
      else process.env.HELIUM_OPSD_LOG_ROOT = previous;
    }
  });
});
