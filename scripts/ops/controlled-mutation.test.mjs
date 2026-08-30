import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  assertCandidateOpsdPlist,
  assertCandidateRelease,
  createControlledMutationLayout,
  productionCandidateValidator,
  runControlledMutation,
  waitForFreshZeroActionCycle,
} from "./controlled-mutation.mjs";

const NOW = new Date("2026-08-30T04:00:00.000Z");
const roots = [];
test.afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

class FakeLaunchctl {
  calls = [];
  labels = new Set([
    "com.helium.opsd",
    "com.moremeds.colima-runtime-watchdog",
    "com.moremeds.colima-after-datalake",
  ]);
  constructor(layout) { this.layout = layout; }
  async run(executable, argv) {
    this.calls.push([executable, ...argv]);
    assert.equal(executable, "/bin/launchctl");
    if (argv[0] === "list") {
      return {
        exitCode: 0,
        stdout: ["PID\tStatus\tLabel", ...[...this.labels].sort().map((label) => `-\t0\t${label}`)].join("\n"),
      };
    }
    if (argv[0] === "print") {
      const label = argv[1].split("/").at(-1);
      return { exitCode: this.labels.has(label) ? 0 : 113, stdout: "" };
    }
    if (argv[0] === "bootout") {
      const label = argv[1].split("/").at(-1);
      this.labels.delete(label);
      return { exitCode: 0, stdout: "" };
    }
    if (argv[0] === "bootstrap") {
      const byPath = new Map([
        [this.layout.opsdPlist, "com.helium.opsd"],
        [this.layout.candidateOpsdPlist, "com.helium.opsd"],
        [this.layout.legacyRuntimePlist, "com.moremeds.colima-runtime-watchdog"],
        [this.layout.legacyAfterDataLakePlist, "com.moremeds.colima-after-datalake"],
      ]);
      const label = byPath.get(argv[2]);
      assert.ok(label, `unexpected plist ${argv[2]}`);
      this.labels.add(label);
      if (label === "com.helium.opsd") {
        const config = JSON.parse(readFileSync(this.layout.activeConfig, "utf8"));
        writeFileSync(this.layout.eventsPath, `${JSON.stringify({ record: {
          at: NOW.toISOString(),
          type: "controller-cycle-recorded",
          controllerId: "com.helium.opsd",
          releaseRef: config.releaseDir,
          observationCount: 1,
          collectionFailureCount: 0,
        } })}\n`, { flag: "a" });
      }
      return { exitCode: 0, stdout: "" };
    }
    throw new Error(`unexpected launchctl argv: ${argv.join(" ")}`);
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "helium-controlled-mutation-"));
  roots.push(root);
  const baseLayout = createControlledMutationLayout(root, process.getuid?.() ?? 0);
  const releaseDir = join(root, "release");
  const layout = {
    ...baseLayout,
    opsdBinary: join(releaseDir, "plugins", "ops-agent", "lib", "bin", "opsd.js"),
    opsdRunner: join(releaseDir, "scripts", "ops", "run-opsd.sh"),
    controlledMutation: join(releaseDir, "scripts", "ops", "controlled-mutation.mjs"),
  };
  for (const dir of [layout.opsRoot, layout.launchdRoot, layout.promotionRoot]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  mkdirSync(join(layout.opsRoot, "config"), { recursive: true, mode: 0o700 });
  mkdirSync(join(layout.opsRoot, "state"), { recursive: true, mode: 0o700 });
  const write = (path, value, mode) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, value, { mode });
    chmodSync(path, mode);
  };
  write(layout.activeConfig, JSON.stringify({ version: 1, mode: "observe", releaseDir }), 0o600);
  write(layout.candidateConfig, JSON.stringify({
    version: 1,
    mode: "approve",
    releaseDir,
    promotionBundleDir: join(releaseDir, "ops", "promotions", "trading-stack-reconcile"),
    authorityManifestPath: layout.authorityManifest,
    trustedKeyPath: layout.publicKey,
  }), 0o600);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  write(layout.publicKey, publicKey.export({ type: "spki", format: "pem" }), 0o600);
  const unsignedPromotion = {
    version: 1,
    promotionId: "trading-stack-reconcile",
    issuedAt: new Date(NOW.getTime() - 60_000).toISOString(),
    expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
    release: { dir: releaseDir, commit: "fixture-commit" },
    rollbackRef: "rollback://observe-config-and-two-legacy-plists",
  };
  const promotion = {
    ...unsignedPromotion,
    inputSha256: createHash("sha256").update(canonical(unsignedPromotion)).digest("hex"),
  };
  write(layout.promotionInput, JSON.stringify(promotion), 0o600);
  write(layout.authorityManifest, JSON.stringify({
    entries: [{ sopId: "trading-stack-container-reconcile" }],
    promotion: {
      promotionId: promotion.promotionId,
      inputSha256: promotion.inputSha256,
    },
    signature: "fixture",
  }), 0o600);
  write(layout.wrapper, "wrapper\n", 0o500);
  write(layout.delegate, "delegate\n", 0o500);
  write(layout.opsdBinary, "opsd\n", 0o500);
  write(layout.opsdRunner, "runner\n", 0o500);
  write(layout.controlledMutation, "controlled mutation\n", 0o500);
  write(layout.opsdPlist, "opsd plist\n", 0o600);
  write(layout.candidateOpsdPlist, "candidate opsd plist\n", 0o600);
  write(layout.legacyRuntimePlist, "runtime plist\n", 0o600);
  write(layout.legacyAfterDataLakePlist, "after datalake plist\n", 0o600);
  write(layout.eventsPath, "", 0o600);

  const artifactPaths = {
    activeConfig: layout.activeConfig,
    candidateConfig: layout.candidateConfig,
    promotionInput: layout.promotionInput,
    authorityManifest: layout.authorityManifest,
    publicKey: layout.publicKey,
    wrapper: layout.wrapper,
    delegate: layout.delegate,
    opsdBinary: layout.opsdBinary,
    opsdRunner: layout.opsdRunner,
    controlledMutation: layout.controlledMutation,
    opsdPlist: layout.opsdPlist,
    candidateOpsdPlist: layout.candidateOpsdPlist,
    legacyRuntimePlist: layout.legacyRuntimePlist,
    legacyAfterDataLakePlist: layout.legacyAfterDataLakePlist,
  };
  const artifacts = Object.fromEntries(Object.entries(artifactPaths).map(([id, path]) => [id, {
    path,
    sha256: sha(path),
    uid: lstatSync(path).uid,
    mode: lstatSync(path).mode & 0o777,
  }]));
  const payload = {
    version: 1,
    promotionId: "trading-stack-reconcile",
    issuedAt: promotion.issuedAt,
    expiresAt: promotion.expiresAt,
    promotionInputSha256: promotion.inputSha256,
    release: promotion.release,
    rollbackRef: promotion.rollbackRef,
    artifacts,
  };
  write(layout.promotionPackage, JSON.stringify({
    payload,
    signature: sign(null, Buffer.from(canonical(payload)), privateKey).toString("base64"),
  }), 0o600);
  const runner = new FakeLaunchctl(layout);
  return { root, layout, runner, privateKey, promotion };
}

function options(f, overrides = {}) {
  return {
    layout: f.layout,
    runner: f.runner,
    validateCandidate: async ({
      executable,
      configPath,
      activeConfigPath,
      releaseDir,
      releaseCommit,
      plistPath,
    }) => {
      assert.equal(executable, f.layout.opsdBinary);
      assert.equal(configPath, f.layout.candidateConfig);
      assert.equal(activeConfigPath, f.layout.activeConfig);
      assert.equal(releaseDir, f.promotion.release.dir);
      assert.equal(releaseCommit, f.promotion.release.commit);
      assert.equal(plistPath, f.layout.candidateOpsdPlist);
    },
    now: () => NOW,
    ...overrides,
  };
}

test("exposes only preflight, handoff, and rollback", async () => {
  const f = fixture();
  await assert.rejects(runControlledMutation("execute", options(f)), /unknown subcommand/);
  assert.match(
    createControlledMutationLayout().expectedPromotionKeySha256,
    /^[0-9a-f]{64}$/,
  );
});

test("candidate plist is bound to the exact release runner and active config", () => {
  const releaseDir = "/Users/moremeds/projects/helium-ops-candidates/candidate";
  const configPath = "/Users/moremeds/.helium/ops/config/opsd.json";
  const plist = {
    Label: "com.helium.opsd",
    ProgramArguments: ["/bin/bash", `${releaseDir}/scripts/ops/run-opsd.sh`],
    WorkingDirectory: releaseDir,
    RunAtLoad: true,
    KeepAlive: true,
    EnvironmentVariables: {
      HELIUM_OPSD_CONFIG: configPath,
      HELIUM_NODE_BIN: "/opt/homebrew/bin/node",
      HOME: "/Users/moremeds",
    },
  };
  assert.doesNotThrow(() => assertCandidateOpsdPlist(plist, { configPath, releaseDir }));
  assert.throws(() => assertCandidateOpsdPlist({
    ...plist,
    ProgramArguments: ["/bin/bash", "/old/release/scripts/ops/run-opsd.sh"],
  }, { configPath, releaseDir }), /exact release and config/);
});

test("candidate release must be the exact clean signed checkout", async () => {
  assert.doesNotThrow(() => assertCandidateRelease({
    expectedCommit: "abc123",
    actualCommit: "abc123\n",
    status: "",
  }));
  assert.throws(() => assertCandidateRelease({
    expectedCommit: "abc123",
    actualCommit: "def456\n",
    status: "",
  }), /commit mismatch/);
  assert.throws(() => assertCandidateRelease({
    expectedCommit: "abc123",
    actualCommit: "abc123\n",
    status: " M scripts\/ops\/run-opsd.sh\n",
  }), /not clean/);

  const releaseDir = "/Users/moremeds/projects/helium-ops-candidates/candidate";
  const candidateConfig = "/Users/moremeds/.helium/ops/promotions/trading-stack-reconcile/opsd.approve.json";
  const activeConfig = "/Users/moremeds/.helium/ops/config/opsd.json";
  const executable = `${releaseDir}/plugins/ops-agent/lib/bin/opsd.js`;
  const plistPath = "/Users/moremeds/.helium/ops/promotions/trading-stack-reconcile/com.helium.opsd.approve.plist";
  const calls = [];
  const validator = productionCandidateValidator({
    run: async (program, argv) => {
      calls.push([program, ...argv]);
      if (program === "/usr/bin/git" && argv.at(-2) === "rev-parse") return "abc123\n";
      if (program === "/usr/bin/git" && argv.at(-2) === "status") return "";
      if (program === "/usr/bin/plutil") return JSON.stringify({
        Label: "com.helium.opsd",
        ProgramArguments: ["/bin/bash", `${releaseDir}/scripts/ops/run-opsd.sh`],
        WorkingDirectory: releaseDir,
        RunAtLoad: true,
        KeepAlive: true,
        EnvironmentVariables: {
          HELIUM_OPSD_CONFIG: activeConfig,
          HELIUM_NODE_BIN: "/opt/homebrew/bin/node",
          HOME: "/Users/moremeds",
        },
      });
      return "";
    },
  });
  await validator({
    executable,
    configPath: candidateConfig,
    activeConfigPath: activeConfig,
    releaseDir,
    releaseCommit: "abc123",
    plistPath,
  });
  assert.deepEqual(calls, [
    [process.execPath, executable, "--check-config", candidateConfig, "--release", releaseDir],
    ["/usr/bin/git", "-C", releaseDir, "rev-parse", "HEAD"],
    ["/usr/bin/git", "-C", releaseDir, "status", "--porcelain"],
    ["/usr/bin/plutil", "-convert", "json", "-o", "-", plistPath],
  ]);
});

test("preflight is read-only and rejects identity or path ambiguity", async () => {
  const f = fixture();
  const before = sha(f.layout.activeConfig);
  const result = await runControlledMutation("preflight", options(f));
  assert.equal(result.state, "ready");
  assert.equal(sha(f.layout.activeConfig), before);
  assert.equal(lstatSync(f.layout.journalPath, { throwIfNoEntry: false }), undefined);

  chmodSync(f.layout.wrapper, 0o700);
  await assert.rejects(runControlledMutation("preflight", options(f)), /mode mismatch/);

  const g = fixture();
  rmSync(g.layout.delegate);
  symlinkSync(g.layout.wrapper, g.layout.delegate);
  await assert.rejects(runControlledMutation("preflight", options(g)), /symlink/);
});

test("preflight rejects future packages, extra controllers, and unsigned drift", async () => {
  const future = fixture();
  const envelope = JSON.parse(readFileSync(future.layout.promotionPackage, "utf8"));
  envelope.payload.issuedAt = new Date(NOW.getTime() + 1).toISOString();
  envelope.signature = sign(
    null,
    Buffer.from(canonical(envelope.payload)),
    future.privateKey,
  ).toString("base64");
  writeFileSync(future.layout.promotionPackage, JSON.stringify(envelope));
  await assert.rejects(
    runControlledMutation("preflight", options(future)),
    /future-dated/,
  );

  const extra = fixture();
  extra.runner.labels.add("com.moremeds.colima-rogue");
  await assert.rejects(
    runControlledMutation("preflight", options(extra)),
    /extra Colima controller/,
  );

  const drift = fixture();
  chmodSync(drift.layout.candidateConfig, 0o700);
  writeFileSync(drift.layout.candidateConfig, "{}\n");
  chmodSync(drift.layout.candidateConfig, 0o600);
  await assert.rejects(
    runControlledMutation("preflight", options(drift)),
    /hash mismatch/,
  );

  const invalidCandidate = fixture();
  await assert.rejects(
    runControlledMutation("preflight", options(invalidCandidate, {
      validateCandidate: async () => { throw new Error("candidate invalid"); },
    })),
    /candidate invalid/,
  );
});

test("handoff releases both legacy labels before switching and proves a zero-action approve cycle", async () => {
  const f = fixture();
  const result = await runControlledMutation("handoff", options(f));
  assert.equal(result.state, "approve-ready");
  assert.deepEqual([...f.runner.labels].sort(), ["com.helium.opsd"]);
  assert.equal(JSON.parse(readFileSync(f.layout.activeConfig, "utf8")).mode, "approve");
  assert.ok(lstatSync(f.layout.backupManifest).isFile());
  const calls = f.runner.calls.map((call) => call.join(" "));
  assert.ok(calls.findIndex((line) => line.includes("bootout") && line.includes("runtime-watchdog")) <
    calls.findIndex((line) => line.includes("bootstrap") && line.includes(f.layout.candidateOpsdPlist)));
  assert.ok(calls.findIndex((line) => line.includes("bootout") && line.includes("after-datalake")) <
    calls.findIndex((line) => line.includes("bootstrap") && line.includes(f.layout.candidateOpsdPlist)));
});

test("approve-cycle proof waits for the fresh zero-action condition", async () => {
  const f = fixture();
  writeFileSync(f.layout.eventsPath, "");
  let polls = 0;
  await waitForFreshZeroActionCycle(f.layout, NOW, () => NOW, {
    timeoutMs: 100,
    pollIntervalMs: 1,
    monotonicNow: () => polls,
    sleep: async () => {
      polls += 1;
      if (polls === 3) {
        writeFileSync(f.layout.eventsPath, `${JSON.stringify({ record: {
          at: NOW.toISOString(),
          type: "controller-cycle-recorded",
          controllerId: "com.helium.opsd",
          releaseRef: f.promotion.release.dir,
          observationCount: 1,
          collectionFailureCount: 0,
        } })}\n`, { flag: "a" });
      }
    },
  });
  assert.equal(polls, 3);
});

test("approve-cycle proof timestamps the event snapshot after reading it", async () => {
  const f = fixture();
  writeFileSync(f.layout.eventsPath, "");
  const cycleAt = new Date(NOW.getTime() + 1);
  let clockReads = 0;
  await waitForFreshZeroActionCycle(f.layout, NOW, () => {
    clockReads += 1;
    if (clockReads === 1) {
      writeFileSync(f.layout.eventsPath, `${JSON.stringify({ record: {
        at: cycleAt.toISOString(),
        type: "controller-cycle-recorded",
        controllerId: "com.helium.opsd",
        releaseRef: f.promotion.release.dir,
        observationCount: 1,
        collectionFailureCount: 0,
      } })}\n`, { flag: "a" });
      return NOW;
    }
    return cycleAt;
  }, {
    timeoutMs: 100,
    pollIntervalMs: 1,
    sleep: async () => {},
  });
  assert.equal(clockReads, 2);
});

test("approve-cycle proof ignores only an incomplete concurrent tail", async () => {
  const f = fixture();
  writeFileSync(f.layout.eventsPath, `${JSON.stringify({ record: {
    at: NOW.toISOString(),
    type: "controller-cycle-recorded",
    controllerId: "com.helium.opsd",
    releaseRef: f.promotion.release.dir,
    observationCount: 1,
    collectionFailureCount: 0,
  } })}\n{"hash":`);
  await waitForFreshZeroActionCycle(f.layout, NOW, () => NOW);
});

test("approve-cycle proof remains bounded and refuses any action", async () => {
  const timeout = fixture();
  writeFileSync(timeout.layout.eventsPath, "");
  let clock = 0;
  await assert.rejects(waitForFreshZeroActionCycle(timeout.layout, NOW, () => NOW, {
    timeoutMs: 3,
    pollIntervalMs: 1,
    monotonicNow: () => clock,
    sleep: async () => { clock += 1; },
  }), /within 3ms/);

  const action = fixture();
  writeFileSync(action.layout.eventsPath, `${JSON.stringify({ record: {
    at: NOW.toISOString(),
    type: "action-intent-recorded",
  } })}\n`);
  await assert.rejects(
    waitForFreshZeroActionCycle(action.layout, NOW, () => NOW),
    /was not zero-action/,
  );
});

test("handoff backs up the signed release paths instead of layout placeholders", async () => {
  const f = fixture();
  const releaseArtifacts = {
    opsdBinary: f.layout.opsdBinary,
    opsdRunner: f.layout.opsdRunner,
    controlledMutation: f.layout.controlledMutation,
  };
  f.layout.opsdBinary = join(f.layout.promotionRoot, "missing-opsd.js");
  f.layout.opsdRunner = join(f.layout.promotionRoot, "missing-run-opsd.sh");
  f.layout.controlledMutation = join(f.layout.promotionRoot, "missing-controlled-mutation.mjs");
  await runControlledMutation("handoff", options(f, { validateCandidate: async () => {} }));
  for (const [key, source] of Object.entries(releaseArtifacts)) {
    assert.equal(
      readFileSync(join(f.layout.backupRoot, `${key}.bin`), "utf8"),
      readFileSync(source, "utf8"),
    );
  }
});

test("rollback restores observe config and the exact legacy controller family", async () => {
  const f = fixture();
  await runControlledMutation("handoff", options(f));
  const result = await runControlledMutation("rollback", options(f));
  assert.equal(result.state, "observe-restored");
  assert.equal(JSON.parse(readFileSync(f.layout.activeConfig, "utf8")).mode, "observe");
  assert.deepEqual([...f.runner.labels].sort(), [
    "com.helium.opsd",
    "com.moremeds.colima-after-datalake",
    "com.moremeds.colima-runtime-watchdog",
  ]);
});

test("rollback refuses a missing durable backup or post-handoff identity drift", async () => {
  const missing = fixture();
  mkdirSync(dirname(missing.layout.journalPath), { recursive: true, mode: 0o700 });
  writeFileSync(missing.layout.journalPath, "{}\n", { mode: 0o600 });
  await assert.rejects(
    runControlledMutation("rollback", options(missing)),
    /requires the durable backup/,
  );

  const drift = fixture();
  await runControlledMutation("handoff", options(drift));
  chmodSync(drift.layout.wrapper, 0o700);
  writeFileSync(drift.layout.wrapper, "different wrapper\n");
  chmodSync(drift.layout.wrapper, 0o500);
  await assert.rejects(
    runControlledMutation("rollback", options(drift)),
    /wrapper hash mismatch/,
  );
});

test("every interrupted handoff prefix converges through rollback", async () => {
  for (let crashAfterStep = 1; crashAfterStep <= 8; crashAfterStep += 1) {
    const f = fixture();
    await assert.rejects(
      runControlledMutation("handoff", options(f, { crashAfterStep })),
      /injected crash/,
    );
    await runControlledMutation("rollback", options(f));
    assert.equal(JSON.parse(readFileSync(f.layout.activeConfig, "utf8")).mode, "observe");
    assert.deepEqual([...f.runner.labels].sort(), [
      "com.helium.opsd",
      "com.moremeds.colima-after-datalake",
      "com.moremeds.colima-runtime-watchdog",
    ]);
  }
});

test("every interrupted rollback prefix converges when rollback is repeated", async () => {
  for (let crashAfterStep = 1; crashAfterStep <= 6; crashAfterStep += 1) {
    const f = fixture();
    await runControlledMutation("handoff", options(f));
    await assert.rejects(
      runControlledMutation("rollback", options(f, { crashAfterStep })),
      /injected crash/,
    );
    await runControlledMutation("rollback", options(f));
    assert.equal(JSON.parse(readFileSync(f.layout.activeConfig, "utf8")).mode, "observe");
    assert.deepEqual([...f.runner.labels].sort(), [
      "com.helium.opsd",
      "com.moremeds.colima-after-datalake",
      "com.moremeds.colima-runtime-watchdog",
    ]);
  }
});
