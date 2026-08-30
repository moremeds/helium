import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  chmodSync,
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
import { canonicalJson, manifestSigningPayload } from "@helium/core";
import { parse, stringify } from "yaml";
import type { CommandRunner } from "../probes/process.js";
import {
  composeOpsDaemon,
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

function approveFixture() {
  const root = mkdtempSync(join(tmpdir(), "helium-opsd-approve-"));
  roots.push(root);
  const promotionBundleDir = join(root, "promotion");
  cpSync(
    join(releaseDir, "ops/promotions/trading-stack-reconcile"),
    promotionBundleDir,
    { recursive: true },
  );
  mkdirSync(join(root, "ops"), { recursive: true });
  for (const name of ["registered-probes.json", "observation-targets.yaml"]) {
    cpSync(join(releaseDir, "ops", name), join(root, "ops", name));
  }
  mkdirSync(join(root, "scripts", "ops"), { recursive: true });
  for (const name of ["read-latest-heartbeats.mjs", "check-parquet-integrity.py"]) {
    cpSync(join(releaseDir, "scripts", "ops", name), join(root, "scripts", "ops", name));
  }

  const wrapperPath = join(root, "trading-stack-reconcile.mjs");
  writeFileSync(wrapperPath, "#!/usr/bin/env node\nprocess.exitCode = 0;\n");
  chmodSync(wrapperPath, 0o500);
  const wrapperSha = createHash("sha256").update(readFileSync(wrapperPath)).digest("hex");
  const executorPath = join(promotionBundleDir, "executors", "trading-stack-reconcile.yaml");
  const executor = parse(readFileSync(executorPath, "utf8"));
  executor.path = wrapperPath;
  executor.identity.value = wrapperSha;
  executor.cwd = root;
  executor.expectedOwnerUid = process.getuid?.() ?? 0;
  writeFileSync(executorPath, stringify(executor));

  const sopPath = join(
    promotionBundleDir,
    "sops",
    "trading-stack-container-reconcile.yaml",
  );
  const sop = parse(readFileSync(sopPath, "utf8"));
  sop.action.executable.path = wrapperPath;
  sop.action.executable.identity.value = wrapperSha;
  const { digest: _digest, ...unsigned } = sop;
  sop.digest = `sha256:${createHash("sha256").update(canonicalJson(unsigned)).digest("hex")}`;
  writeFileSync(sopPath, stringify(sop));

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const trustedKeyPath = join(root, "authority.pub.pem");
  writeFileSync(trustedKeyPath, publicKey.export({ type: "spki", format: "pem" }));
  const entries = [{
    sopId: sop.id,
    version: sop.version,
    digest: sop.digest,
    authority: sop.authority,
  }];
  const authorityManifestPath = join(root, "authority-manifest.json");
  const promotion = {
    promotionId: "trading-stack-reconcile",
    inputSha256: "b".repeat(64),
  };
  writeFileSync(authorityManifestPath, JSON.stringify({
    entries,
    promotion,
    signature: sign(null, manifestSigningPayload(entries, promotion), privateKey).toString("base64"),
  }));

  const config = {
    version: 1 as const,
    mode: "approve" as const,
    releaseDir: root,
    promotionBundleDir,
    componentsDir: "components",
    dependenciesDir: "dependencies",
    checksDir: "checks",
    sopsDir: "sops",
    executorsDir: "executors",
    authorityManifestPath,
    trustedKeyPath,
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
  return { root, config, promotionBundleDir, wrapperPath, authorityManifestPath };
}

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

  it("keeps observe independent but requires an explicit bundle above observe", () => {
    const root = mkdtempSync(join(tmpdir(), "helium-opsd-modes-"));
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
      authorityManifestPath: join(root, "missing-authority.json"),
      trustedKeyPath: join(releaseDir, "ops/authority-manifest.pub.pem"),
      stateDir: join(root, "state"),
      socketPath: join(root, "run", "opsd.sock"),
      observationTargetsPath: join(releaseDir, "ops/observation-targets.yaml"),
      intervalMs: 60_000,
      maxFiles: 500,
      maxComponents: 200,
      maxSops: 200,
      maxChecks: 500,
      maxFileBytes: 1_000_000,
    };

    expect(() => composeOpsDaemon(config)).not.toThrow();
    expect(() => composeOpsDaemon({ ...config, mode: "suggest" as const })).toThrow(
      /suggest.*promotion bundle/i,
    );
    expect(() => composeOpsDaemon({ ...config, mode: "approve" as const })).toThrow(
      /approve.*promotion bundle/i,
    );
  });

  it("loads the exact signed promotion bundle in suggest mode", () => {
    const valid = approveFixture();
    const suggest = { ...valid.config, mode: "suggest" as const };
    expect(() => validateOpsdRelease(suggest)).not.toThrow();
    expect(() => composeOpsDaemon(suggest)).not.toThrow();

    const unsigned = approveFixture();
    const manifest = JSON.parse(readFileSync(unsigned.authorityManifestPath, "utf8"));
    writeFileSync(unsigned.authorityManifestPath, JSON.stringify({
      ...manifest,
      signature: Buffer.alloc(64).toString("base64"),
    }));
    expect(() => composeOpsDaemon({ ...unsigned.config, mode: "suggest" as const }))
      .toThrow(/exact signed authority grant/i);
  });

  it("requires an exact signed, owned, identity-matched approve composition", () => {
    const valid = approveFixture();
    expect(() => validateOpsdRelease(valid.config)).not.toThrow();
    expect(() => composeOpsDaemon(valid.config)).not.toThrow();

    chmodSync(valid.wrapperPath, 0o700);
    writeFileSync(valid.wrapperPath, "#!/usr/bin/env node\nprocess.exitCode = 1;\n");
    chmodSync(valid.wrapperPath, 0o500);
    expect(() => composeOpsDaemon(valid.config)).toThrow(/executor identity.*script-drift/i);

    const unsigned = approveFixture();
    const manifest = JSON.parse(readFileSync(unsigned.authorityManifestPath, "utf8"));
    writeFileSync(unsigned.authorityManifestPath, JSON.stringify({
      ...manifest,
      signature: Buffer.alloc(64).toString("base64"),
    }));
    expect(() => composeOpsDaemon(unsigned.config)).toThrow(/exact signed authority grant/i);

    const external = approveFixture();
    const componentPath = join(external.promotionBundleDir, "components", "colima.yaml");
    const component = parse(readFileSync(componentPath, "utf8"));
    component.mutationOwner.owner = "external";
    component.mutationOwner.externalOwnerLabel = "com.moremeds.colima-runtime-watchdog";
    writeFileSync(componentPath, stringify(component));
    expect(() => composeOpsDaemon(external.config)).toThrow(/not certified.*external/i);
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
