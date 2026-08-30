import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandRunner } from "../probes/process.js";
import {
  composeObserveOnlyOpsDaemon,
  loadOpsdRuntimeConfig,
  parseOpsdArgs,
  validateOpsdRelease,
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
      observationTargetsPath: `${releaseDir}/ops/observation-targets.yaml`,
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
        observationTargetsPath: `${releaseDir}/ops/observation-targets.yaml`,
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
      expect(commands).toBeGreaterThan(7);
      const log = readFileSync(join(root, "state", "events.jsonl"), "utf8");
      expect(log).toContain('"type":"observation-recorded"');
      expect(log).toContain('"componentId":"host"');
      expect(log).toContain('"type":"controller-cycle-recorded"');
      expect(log).toContain(`"releaseRef":"${releaseDir.replace(/\/$/, "")}"`);
    } finally {
      await daemon.stop();
    }
  });

  it("validates the complete configured bundle against a candidate release", () => {
    const root = mkdtempSync(join(tmpdir(), "helium-opsd-preflight-"));
    roots.push(root);
    const config = {
      version: 1 as const,
      mode: "observe" as const,
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
      observationTargetsPath: `${releaseDir}/ops/observation-targets.yaml`,
      intervalMs: 60000,
      maxFiles: 500,
      maxComponents: 200,
      maxSops: 200,
      maxChecks: 500,
      maxFileBytes: 1000000,
    };
    expect(() => validateOpsdRelease(config, releaseDir)).not.toThrow();
    expect(() => validateOpsdRelease({ ...config, executorsDir: "ops/checks" }, releaseDir))
      .toThrow();
    expect(() => validateOpsdRelease(config, root)).toThrow(
      /observation targets|ENOENT|no such file/i,
    );
  });

  it("rejects YAML checks that have no compiled runtime probe", () => {
    const root = mkdtempSync(join(tmpdir(), "helium-opsd-unregistered-"));
    roots.push(root);
    cpSync(join(releaseDir, "ops"), join(root, "ops"), { recursive: true });
    mkdirSync(join(root, "scripts", "ops"), { recursive: true });
    for (const name of ["read-latest-heartbeats.mjs", "check-parquet-integrity.py"]) {
      cpSync(join(releaseDir, "scripts", "ops", name), join(root, "scripts", "ops", name));
    }
    const checkPath = join(root, "ops", "checks", "colima-transport-ready.yaml");
    const originalCheck = readFileSync(checkPath, "utf8");
    writeFileSync(
      checkPath,
      originalCheck.replace("colima.guest-runtime.v1", "fixture.yaml-only.v1"),
    );
    const config = {
      version: 1 as const,
      mode: "observe" as const,
      releaseDir: root,
      componentsDir: "ops/components",
      dependenciesDir: "ops/dependencies",
      checksDir: "ops/checks",
      sopsDir: "ops/sops",
      executorsDir: "ops/executors",
      authorityManifestPath: join(root, "ops", "authority-manifest.json"),
      trustedKeyPath: join(root, "ops", "authority-manifest.pub.pem"),
      stateDir: join(root, "state"),
      socketPath: join(root, "run", "opsd.sock"),
      observationTargetsPath: join(root, "ops", "observation-targets.yaml"),
      intervalMs: 60_000,
      maxFiles: 500,
      maxComponents: 200,
      maxSops: 200,
      maxChecks: 500,
      maxFileBytes: 1_000_000,
    };

    expect(() => validateOpsdRelease(config)).toThrow(/unregistered probe.*fixture\.yaml-only\.v1/i);
    expect(() => composeObserveOnlyOpsDaemon(config)).toThrow(
      /unregistered probe.*fixture\.yaml-only\.v1/i,
    );

    writeFileSync(checkPath, originalCheck);
    const inventoryPath = join(root, "ops", "registered-probes.json");
    const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
    writeFileSync(inventoryPath, JSON.stringify({
      ...inventory,
      probeIds: inventory.probeIds.slice(1),
    }));
    expect(() => validateOpsdRelease(config)).toThrow(/inventory.*compiled runtime/i);

    writeFileSync(inventoryPath, JSON.stringify({
      ...inventory,
      probeIds: [...inventory.probeIds, "fixture.extra.v1"],
    }));
    expect(() => validateOpsdRelease(config)).toThrow(/inventory.*compiled runtime/i);
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
