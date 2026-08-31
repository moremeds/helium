import { execFileSync, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActionLeaseController,
  ActionLeaseTable,
  OperationsStore,
  canonicalJson,
  manifestSigningPayload,
} from "@helium/core";
import {
  ApprovalLedger,
  ComponentRegistry,
  FileComponentActionLocks,
  FileRecoveryEvidenceStore,
  ScriptExecutor,
  ScriptRegistry,
  authorizeAutomaticArgv,
  createStandaloneOpsDaemon,
  type CommandRunner,
} from "dsh-plugin-ops-agent";
import {
  FileAppendCoordination,
  LivewireRepairCheckSampler,
  ShepherdRepairOpsAdapter,
  ShepherdRepairOutcomeProjector,
  ShepherdRepairPreparer,
  createWorkUnit,
  openShepherdStore,
  repairManifestFilename,
} from "dsh-plugin-livewire-shepherd";
import { describe, expect, it } from "vitest";
import { DuckDBInstance } from "@duckdb/node-api";
// The deployment builder is an executable ESM script rather than a TS package.
// @ts-expect-error its exported runtime discovery function is exercised here directly.
import { discoverPythonRuntimeFiles } from "../../scripts/ops/prepare-livewire-shepherd-promotion.mjs";

const NOW = new Date("2026-08-31T22:00:00.000Z");
const ACTUAL_LIVEWIRE_ROOT = process.env.HELIUM_LIVEWIRE_ROOT;
const EXPECTED_LIVEWIRE_COMMIT = process.env.HELIUM_LIVEWIRE_COMMIT;
const REQUIRE_ACTUAL_LIVEWIRE = process.env.HELIUM_REQUIRE_LIVEWIRE_CONTRACT === "1";
const IS_MACOS = process.platform === "darwin";

function hash(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function renderWrapper(input: {
  template: string;
  readyDir: string;
  python: string;
  livewireRoot: string;
  dataLakeRoot: string;
  sourceManifest: string;
  command: "transaction" | "postcondition";
  target: string;
  pythonRuntimeFiles?: Array<{ path: string; sha256: string }>;
}): void {
  const pythonRuntimeManifest = join(input.readyDir, "python-runtime.sha256");
  writeFileSync(
    pythonRuntimeManifest,
    `${(input.pythonRuntimeFiles ?? [{ path: input.python, sha256: hash(readFileSync(input.python)) }])
      .map((file) => `${file.sha256}  ${file.path}`).join("\n")}\n`,
    { mode: 0o600 },
  );
  const replacements: Record<string, string> = {
    __READY_DIR__: input.readyDir,
    __PYTHON_BIN__: input.python,
    __PYTHON_SHA256__: hash(readFileSync(input.python)),
    __LIVEWIRE_ROOT__: input.livewireRoot,
    __SOURCE_MANIFEST__: input.sourceManifest,
    __SOURCE_MANIFEST_SHA256__: hash(readFileSync(input.sourceManifest)),
    __PYTHON_RUNTIME_MANIFEST__: pythonRuntimeManifest,
    __PYTHON_RUNTIME_MANIFEST_SHA256__: hash(readFileSync(pythonRuntimeManifest)),
    __DATA_LAKE_ROOT__: input.dataLakeRoot,
    __COMMAND__: input.command,
    __CHILD_TIMEOUT_SECONDS__: "60",
  };
  let body = input.template;
  for (const [key, value] of Object.entries(replacements)) body = body.replaceAll(key, value);
  if (/__[A-Z0-9_]+__/.test(body)) throw new Error("unresolved wrapper placeholder");
  writeFileSync(input.target, body, { mode: 0o500 });
  chmodSync(input.target, 0o500);
}

async function writeParquet(path: string, close: number): Promise<void> {
  const db = await DuckDBInstance.create(":memory:");
  const connection = await db.connect();
  await connection.run(`COPY (SELECT DATE '2026-08-31' AS session_date, ${close}::DOUBLE AS close) TO '${path.replaceAll("'", "''")}' (FORMAT PARQUET)`);
  connection.closeSync();
}

async function fixture(rollback = false, projectTick = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "helium-livewire-recovery-contract-")));
  const readyDir = join(root, "ready");
  const lake = join(root, "lake");
  const livewireRoot = join(root, "livewire");
  const moduleDir = join(livewireRoot, "livewire_scripts");
  const clientsDir = join(livewireRoot, "clients");
  mkdirSync(readyDir, { recursive: true, mode: 0o700 });
  mkdirSync(lake, { recursive: true, mode: 0o700 });
  mkdirSync(moduleDir, { recursive: true, mode: 0o700 });
  mkdirSync(clientsDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(moduleDir, "__init__.py"), "", { mode: 0o600 });
  const targetParquet = join(lake, "bronze", "asset_class=equity", "symbol=AAPL", "1d.parquet");
  const candidateParquet = join(lake, "staging", "candidate.parquet");
  mkdirSync(join(targetParquet, ".."), { recursive: true, mode: 0o700 });
  mkdirSync(join(candidateParquet, ".."), { recursive: true, mode: 0o700 });
  await writeParquet(targetParquet, 100);
  await writeParquet(candidateParquet, 101);
  const priorBytes = readFileSync(targetParquet);
  const candidateBytes = readFileSync(candidateParquet);
  writeFileSync(join(moduleDir, "shepherd_repair.py"), [
    "import argparse, hashlib, json, pathlib, shutil, sys",
    "p=argparse.ArgumentParser(); p.add_argument('--data-lake-root', required=True); p.add_argument('command'); p.add_argument('--manifest', required=True)",
    "a=p.parse_args(); m=json.loads(pathlib.Path(a.manifest).read_text()); lake=pathlib.Path(a.data_lake_root); target=lake/'bronze'/'asset_class=equity'/'symbol=AAPL'/'1d.parquet'; candidate=lake/'staging'/'candidate.parquet'; backup=target.with_suffix('.prior')",
    "if a.command == 'transaction':",
    rollback
      ? "  shutil.copyfile(target, backup); shutil.copyfile(candidate, target); shutil.copyfile(backup, target); backup.unlink(); print(json.dumps({'state':'ROLLED_BACK'})); sys.exit(1)"
      : "  shutil.copyfile(target, backup); shutil.copyfile(candidate, target); print(json.dumps({'state':'VERIFIED'})); sys.exit(0)",
    `state='VERIFIED' if hashlib.sha256(target.read_bytes()).hexdigest() == '${hash(candidateBytes)}' else 'NOT_VERIFIED'`,
    "print(json.dumps({'state':state})); sys.exit(0 if state == 'VERIFIED' else 1)",
  ].join("\n"), { mode: 0o600 });
  writeFileSync(join(clientsDir, "shepherd_repair.py"), "# fixture mutator\n", { mode: 0o600 });
  const sourceManifest = join(root, "livewire.sha256");
  writeFileSync(sourceManifest, [
    `${hash(readFileSync(join(moduleDir, "__init__.py")))}  livewire_scripts/__init__.py`,
    `${hash(readFileSync(join(moduleDir, "shepherd_repair.py")))}  livewire_scripts/shepherd_repair.py`,
    `${hash(readFileSync(join(clientsDir, "shepherd_repair.py")))}  clients/shepherd_repair.py`,
    "",
  ].join("\n"), { mode: 0o600 });
  const python = execFileSync("/usr/bin/which", ["python3"], { encoding: "utf8" }).trim();
  const template = readFileSync(join(process.cwd(), "scripts/ops/actions/livewire-repair-wrapper.sh.template"), "utf8");
  const transactionPath = join(root, "transaction");
  const postconditionPath = join(root, "postcondition");
  renderWrapper({ template, readyDir, python, livewireRoot, dataLakeRoot: lake, sourceManifest, command: "transaction", target: transactionPath });
  renderWrapper({ template, readyDir, python, livewireRoot, dataLakeRoot: lake, sourceManifest, command: "postcondition", target: postconditionPath });

  const shepherd = openShepherdStore(join(root, "shepherd"));
  const unit = createWorkUnit({
    kind: "security-interval",
    securityId: "sec_00000000000000000000000000000001",
    symbol: "AAPL",
    symbolValidFrom: "2000-01-01T00:00:00Z",
    dateFrom: "2026-08-31",
    dateTo: "2026-08-31",
    timeframe: "1d",
    layer: "bronze",
  });
  const manifest = {
    version: 1,
    operationId: rollback ? "repair-rollback" : "repair-success",
    workUnitId: unit.workUnitId,
    scopeHash: unit.scopeHash,
    dataLakeRoot: lake,
    layer: "bronze",
    securityId: unit.scope.kind === "security-interval" ? unit.scope.securityId : "",
    symbol: "AAPL",
    symbolValidFrom: "2000-01-01T00:00:00Z",
    symbolValidTo: null,
    identityAsOf: "2026-08-31T00:00:00Z",
    securityMasterRevision: 1,
    securityMasterSha256: "b".repeat(64),
    sessionPolicy: "XNYS-close-and-early-close-v2",
    dateFrom: "2026-08-31",
    dateTo: "2026-08-31",
    timeframe: "1d",
    priorArtifacts: [{ path: "bronze/asset_class=equity/symbol=AAPL/1d.parquet", sha256: hash(priorBytes) }],
    sourceEvidence: [{ ref: "artifact://fixture/source", sha256: "d".repeat(64) }],
    maxRows: 10,
    maxBytes: 1_000_000,
    expiresAt: "2026-09-01T23:00:00Z",
    operation: "daily-merge",
  };
  const manifestBytes = JSON.stringify(manifest);
  const saved = shepherd.artifacts.put(manifestBytes);
  const manifestPath = join(readyDir, repairManifestFilename(unit.scopeHash));
  writeFileSync(manifestPath, manifestBytes, { mode: 0o600 });
  chmodSync(manifestPath, 0o600);
  shepherd.append({ version: 1, eventId: "discover", at: NOW.toISOString(), type: "work-unit/discovered", payload: { unit } });
  shepherd.append({
    version: 1, eventId: "repair-intent", at: NOW.toISOString(), type: "repair/intent-recorded",
    payload: {
      workUnitId: unit.workUnitId, expectedRevision: 0, revision: 1,
      repairId: "repair-1", scopeHash: unit.scopeHash, manifest: { ref: saved.ref, hash: saved.hash },
    },
  });
  shepherd.append({
    version: 1, eventId: "ready", at: NOW.toISOString(), type: "work-unit/transitioned",
    payload: {
      workUnitId: unit.workUnitId, expectedRevision: 1, revision: 2,
      from: "DISCOVERED", to: "REPAIR_READY", reason: "fixture repair ready",
    },
  });

  const component = {
    version: 1 as const,
    id: "livewire",
    kind: "data-service",
    dimensions: ["integrity"],
    mutationOwner: {
      owner: "opsd" as const,
      competingLabels: [],
      changedAt: NOW.toISOString(),
      changeRef: "promotion://livewire-repair",
    },
  };
  const check = {
    id: "livewire-repair-verified",
    kind: "business" as const,
    probe: { probeId: "livewire.repair-postcondition.v1", args: {} },
    expect: { dimension: "repair", operator: "eq" as const, value: true },
    onUnavailable: "unknown" as const,
    timeoutMs: 60_000,
    owner: "ops",
  };
  const unsignedSop = {
    version: 1 as const,
    id: "livewire-shepherd-targeted-repair",
    componentId: "livewire",
    matches: { dimension: "integrity", failureClass: "failed" as const },
    authority: "auto" as const,
    mutating: true,
    priority: 100,
    action: {
      executorId: "livewire-repair-transaction",
      executable: { path: transactionPath, identity: { kind: "sha256" as const, value: hash(readFileSync(transactionPath)) } },
      argvSchemaId: "livewire-repair-transaction-v1",
      cwdId: "livewire-workdir",
      environmentProfileId: "ops-minimal",
      timeoutMs: 60_000,
    },
    preconditions: [],
    postconditions: [check.id],
    graceMs: 0,
    maxAttempts: 1,
    cooldownMs: 60_000,
  };
  const sop = {
    ...unsignedSop,
    digest: `sha256:${hash(canonicalJson(unsignedSop))}` as const,
  };
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const entries = [{ sopId: sop.id, version: sop.version, digest: sop.digest, authority: sop.authority }];
  const registry = new ComponentRegistry({
    authority: {
      manifest: { entries, signature: sign(null, manifestSigningPayload(entries), privateKey).toString("base64") },
      trustedKey: publicKey,
    },
    registeredProbeIds: ["livewire.repair-postcondition.v1"],
    now: () => NOW,
  });
  registry.install({ tenantId: "livewire", components: [component], checks: [check], sops: [sop] });
  const scripts = ScriptRegistry.load([{
    executorId: "livewire-repair-transaction",
    path: transactionPath,
    identity: { kind: "sha256" as const, value: hash(readFileSync(transactionPath)) },
    argvSchema: {
      id: "livewire-repair-transaction-v1",
      params: [{ flag: "--manifest", valuePattern: `${readyDir}/sha256:[0-9a-f]{64}\\.json`, required: true }],
    },
    cwd: livewireRoot,
    environmentProfile: {},
    timeoutMs: 60_000,
    maxOutputBytes: 100_000,
    expectedOwnerUid: process.getuid?.() ?? 0,
  }, {
    executorId: "livewire-repair-postcondition",
    path: postconditionPath,
    identity: { kind: "sha256" as const, value: hash(readFileSync(postconditionPath)) },
    argvSchema: {
      id: "livewire-repair-postcondition-v1",
      params: [{ flag: "--manifest", valuePattern: `${readyDir}/sha256:[0-9a-f]{64}\\.json`, required: true }],
    },
    cwd: livewireRoot,
    environmentProfile: {},
    timeoutMs: 60_000,
    maxOutputBytes: 100_000,
    expectedOwnerUid: process.getuid?.() ?? 0,
  }]);
  const sourceBytes = new Map<string, Buffer>();
  sourceBytes.set("artifact://ops/controller/clear", Buffer.from("clear"));
  let rawSequence = 0;
  const runner: CommandRunner = {
    async run(argv, timeoutMs) {
      const result = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", timeout: timeoutMs });
      const ref = `artifact://ops/raw/contract-${++rawSequence}`;
      sourceBytes.set(ref, Buffer.from(`${result.stdout ?? ""}${result.stderr ?? ""}`));
      return {
        stdout: result.stdout ?? "",
        exitCode: result.status ?? 1,
        timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
        evidenceRef: ref,
      };
    },
  };
  const checkSampler = new LivewireRepairCheckSampler({ registry: scripts, executorId: "livewire-repair-postcondition" });
  const cap = {
    kind: "manifest-argv-v1" as const,
    sopId: sop.id,
    componentId: component.id,
    executorId: "livewire-repair-transaction",
    postconditionIds: [check.id],
    manifestRoot: readyDir,
    verificationExecutor: (() => {
      const verifier = scripts.get("livewire-repair-postcondition")!;
      return {
        executorId: verifier.executorId,
        path: verifier.path,
        identity: verifier.identity as { kind: "sha256"; value: string },
        expectedOwnerUid: verifier.expectedOwnerUid,
        argvSchema: verifier.argvSchema,
      };
    })(),
  };
  const preparer = new ShepherdRepairPreparer({
    readyDir,
    dataLakeRoots: [lake],
    now: () => NOW,
    authorizeArgv: (argv) => authorizeAutomaticArgv(cap, argv),
    verifyEvidence: (evidence) => { shepherd.artifacts.verify(evidence.ref, evidence.hash); },
  });
  const adapter = new ShepherdRepairOpsAdapter({
    store: shepherd, preparer, componentId: "livewire", sopId: sop.id, ttlMs: 60_000,
  });
  let readRecoveryEvidence: ((ref: { ref: string; sha256: string }) => Buffer) | undefined;
  const projector = new ShepherdRepairOutcomeProjector({
    store: shepherd,
    componentId: component.id,
    sopId: sop.id,
    coordination: new FileAppendCoordination({ directory: join(root, "append-locks"), bootId: "boot-contract" }),
    now: () => NOW.toISOString(),
    readRecoveryEvidence: (ref) => {
      if (readRecoveryEvidence === undefined) throw new Error("contract recovery evidence is not ready");
      return readRecoveryEvidence(ref);
    },
  });
  const evidence = new FileRecoveryEvidenceStore(join(root, "ops-evidence"), {
    readSourceArtifact: (ref) => {
      if (ref.startsWith("artifact://sha256/")) return shepherd.artifacts.read(ref);
      const bytes = sourceBytes.get(ref);
      if (bytes === undefined) throw new Error(`missing contract source: ${ref}`);
      return bytes;
    },
  });
  readRecoveryEvidence = (ref) => evidence.readArtifact(ref);
  const operations = OperationsStore.open(join(root, "ops-state"), {
    validateEvent: (event) => evidence.verifyEvent(event),
  });
  const daemon = createStandaloneOpsDaemon({
    mode: "auto",
    registry,
    store: operations,
    now: () => NOW,
    runChecks: async () => ({}),
    sampleChecks: async (checksToRun, phase) =>
      (await checkSampler.sample(checksToRun, phase, runner, NOW)) ?? [],
    controllerProbe: {
      async check() {
        return { result: "clear", observedLabels: [], evidenceRef: "artifact://ops/controller/clear" };
      },
    },
    leases: new ActionLeaseController(new ActionLeaseTable(), { controllerId: "contract", ttlMs: 60_000, now: () => NOW }),
    componentLocks: new FileComponentActionLocks({ dir: join(root, "component-locks"), bootId: "boot-contract" }),
    approvals: new ApprovalLedger({ trustedKey: publicKey, now: () => NOW }),
    evidence,
    createExecutor: () => new ScriptExecutor(scripts, { now: () => NOW }),
    argvFor: () => { throw new Error("scoped adapter was bypassed"); },
    prepareAction: (definition, incident, policy) => adapter.prepareAction(definition, incident, policy),
    probes: [adapter],
    runner,
    control: { start: async () => undefined, stop: async () => undefined },
    intervalMs: 60_000,
    ...(projectTick ? { onTickSuccess: () => projector.recordOperations(operations) } : {}),
  });
  return { root, lake, targetParquet, priorBytes, candidateBytes, shepherd, unit, operations, evidence, daemon, projector };
}

describe("Livewire Shepherd autonomous recovery", () => {
  it.runIf(REQUIRE_ACTUAL_LIVEWIRE)("requires an exact clean Livewire checkout for the deployment gate", () => {
    expect(ACTUAL_LIVEWIRE_ROOT, "HELIUM_LIVEWIRE_ROOT is required").toBeTypeOf("string");
    expect(EXPECTED_LIVEWIRE_COMMIT, "HELIUM_LIVEWIRE_COMMIT is required").toMatch(/^[0-9a-f]{40}$/);
  });
  it.runIf(IS_MACOS)("executes one manifest-scoped repair, independently verifies it, and projects VERIFIED", async () => {
    const h = await fixture();
    await h.daemon.start();
    await h.daemon.stop();

    expect(readFileSync(h.targetParquet)).toEqual(h.candidateBytes);
    expect(h.shepherd.load().workUnits[h.unit.workUnitId]?.state).toBe("VERIFIED");
    const terminal = h.operations.replay().find((event) => event.type === "action-verified");
    expect(terminal).toMatchObject({ type: "action-verified", outcome: "succeeded" });
    expect(() => h.evidence.verifyHistory(h.operations.replay())).not.toThrow();
  });

  it.runIf(IS_MACOS)("keeps a rolled-back/nonzero repair out of VERIFIED", async () => {
    const h = await fixture(true);
    await h.daemon.start();
    await h.daemon.stop();

    expect(h.shepherd.load().workUnits[h.unit.workUnitId]?.state).toBe("QUARANTINED");
    expect(readFileSync(h.targetParquet)).toEqual(h.priorBytes);
    expect(h.operations.replay().find((event) => event.type === "action-verified"))
      .toMatchObject({ type: "action-verified", outcome: "failed" });
  });

  it.runIf(IS_MACOS)("cold-resumes projection after the Ops terminal event was durable", async () => {
    const h = await fixture(false, false);
    await h.daemon.start();
    await h.daemon.stop();

    expect(h.operations.replay().find((event) => event.type === "action-verified"))
      .toMatchObject({ type: "action-verified", outcome: "succeeded" });
    expect(h.shepherd.load().workUnits[h.unit.workUnitId]?.state).toBe("REPAIR_READY");

    h.projector.recordOperations(h.operations);
    expect(h.shepherd.load().workUnits[h.unit.workUnitId]?.state).toBe("VERIFIED");
    expect(() => h.evidence.verifyHistory(h.operations.replay())).not.toThrow();
  });

  it.runIf(IS_MACOS && ACTUAL_LIVEWIRE_ROOT !== undefined)(
    "runs the packaged wrapper against the actual pinned Livewire transaction",
    () => {
      const actualRoot = realpathSync(ACTUAL_LIVEWIRE_ROOT!);
      const actualCommit = execFileSync("git", ["-C", actualRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const dirty = execFileSync("git", ["-C", actualRoot, "status", "--porcelain"], { encoding: "utf8" }).trim();
      if (EXPECTED_LIVEWIRE_COMMIT !== undefined) expect(actualCommit).toBe(EXPECTED_LIVEWIRE_COMMIT);
      if (REQUIRE_ACTUAL_LIVEWIRE) expect(dirty, "deployment checkout must be clean").toBe("");
      const python = join(actualRoot, ".venv", "bin", "python");
      if (REQUIRE_ACTUAL_LIVEWIRE) {
        const rollbackGate = execFileSync(python, [
          "-m", "pytest", "-q",
          "tests/test_shepherd_repair.py::test_transaction_rolls_back_when_independent_verification_fails",
        ], { cwd: actualRoot, encoding: "utf8" });
        expect(rollbackGate).toMatch(/1 passed/);
      }
      const root = realpathSync(mkdtempSync(join(tmpdir(), "helium-livewire-actual-contract-")));
      try {
        const lake = join(root, "lake");
        const readyDir = join(root, "ready");
        const runtimeRoot = join(root, "livewire");
        mkdirSync(readyDir, { recursive: true, mode: 0o700 });
        mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
        for (const directory of ["clients", "livewire_scripts"]) {
          cpSync(join(actualRoot, directory), join(runtimeRoot, directory), {
            recursive: true,
            filter: (source) => !source.includes("/__pycache__") && !source.endsWith(".pyc") && !source.endsWith(".pyo"),
          });
        }
        const fixtureScript = [
          "import pathlib, runpy, sys",
          `sys.path.append(${JSON.stringify(actualRoot)})`,
          `ns=runpy.run_path(${JSON.stringify(join(actualRoot, "tests", "test_shepherd_repair.py"))})`,
          `print(ns['_fixture'](pathlib.Path(${JSON.stringify(lake)}), patch_day='2026-08-28', date_from='2026-08-28', date_to='2026-08-28', prior_day='2026-08-27', identity_as_of='2026-08-28T00:00:00Z'))`,
        ].join(";");
        const originalManifest = execFileSync(python, ["-I", "-B", "-s", "-E", "-c", fixtureScript], {
          encoding: "utf8",
        }).trim();
        const manifestBytes = readFileSync(originalManifest);
        const manifestPath = join(readyDir, `sha256:${hash(manifestBytes)}.json`);
        writeFileSync(manifestPath, manifestBytes, { mode: 0o600 });
        chmodSync(manifestPath, 0o600);

        const sourceFiles: string[] = [];
        const visit = (directory: string): void => {
          for (const entry of readdirSync(join(runtimeRoot, directory), { withFileTypes: true })) {
            const child = join(directory, entry.name);
            if (entry.isDirectory()) visit(child);
            else if (entry.isFile() && entry.name.endsWith(".py")) sourceFiles.push(child);
          }
        };
        visit("clients");
        visit("livewire_scripts");
        const sourceManifest = join(root, "livewire.sha256");
        writeFileSync(sourceManifest, `${sourceFiles.sort().map((path) => `${hash(readFileSync(join(runtimeRoot, path)))}  ${path}`).join("\n")}\n`);
        const template = readFileSync(join(process.cwd(), "scripts/ops/actions/livewire-repair-wrapper.sh.template"), "utf8");
        const transaction = join(root, "transaction");
        const postcondition = join(root, "postcondition");
        const pythonRuntimeFiles = discoverPythonRuntimeFiles(python);
        expect(pythonRuntimeFiles.some((file: { path: string }) => file.path.includes("Python.framework") && file.path.endsWith("/Python"))).toBe(true);
        renderWrapper({ template, readyDir, python, livewireRoot: runtimeRoot, dataLakeRoot: lake, sourceManifest, command: "transaction", target: transaction, pythonRuntimeFiles });
        renderWrapper({ template, readyDir, python, livewireRoot: runtimeRoot, dataLakeRoot: lake, sourceManifest, command: "postcondition", target: postcondition, pythonRuntimeFiles });

        const run = (path: string) => execFileSync("/bin/bash", [
          "-c", "printf 'go\\n' | \"$1\" --manifest \"$2\" 3<&0", "helium-livewire-actual", path, manifestPath,
        ], { encoding: "utf8" });
        expect(JSON.parse(run(transaction)).state).toBe("VERIFIED");
        expect(JSON.parse(run(postcondition)).state).toBe("VERIFIED");
        const actualMutator = join(runtimeRoot, "clients", "shepherd_repair.py");
        writeFileSync(actualMutator, Buffer.concat([readFileSync(actualMutator), Buffer.from("\n# drift\n")]));
        expect(() => run(postcondition)).toThrow(/source bytes changed|Command failed/);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
