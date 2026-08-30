import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TeamManifestSchema,
  canonicalJson,
  parseTeamYaml,
  type TeamManifest,
} from "@helium/core";
import { parse as parseYaml } from "yaml";
import {
  evaluatePairedGate,
  fixtureDirectoryHash,
  type PairedEvaluation,
} from "./paired-gate.js";
import {
  decideAutonomy,
  type AutonomyDecisionInput,
  type AutonomyDecisionRecord,
} from "./autonomy.js";

export interface FrozenCase {
  id: string;
  input: { anchorTarget: string; anchorSnapshot: string; [key: string]: unknown };
  control: { unsupportedClaims: number; totalClaims: number };
  treatment: { unsupportedClaims: number; totalClaims: number };
}

export interface EvaluationCatalogSnapshot {
  version: string;
  targets: string[];
}

export interface EvaluationAdapterResult {
  state: PairedEvaluation["control"]["state"];
  unsupportedClaims: number;
  totalClaims: number;
}

export interface EvaluationExecutorAdapter {
  execute(input: {
    arm: "control" | "treatment";
    fixture: Readonly<FrozenCase>;
    manifest: TeamManifest;
    catalogSnapshot: EvaluationCatalogSnapshot;
  }): Promise<EvaluationAdapterResult>;
}

export async function runEvaluation(input: {
  manifest: TeamManifest;
  fixtures: FrozenCase[];
  catalogSnapshot: EvaluationCatalogSnapshot;
  adapters: { control: EvaluationExecutorAdapter; treatment: EvaluationExecutorAdapter };
  live?: boolean;
  runDir?: string;
}): Promise<PairedEvaluation[]> {
  const manifest = TeamManifestSchema.parse(input.manifest);
  if (input.live && process.env.HELIUM_EVAL_LIVE !== "1") {
    throw new Error("live evaluation requires HELIUM_EVAL_LIVE=1");
  }
  const pairs: PairedEvaluation[] = [];
  for (const mutable of input.fixtures) {
    const fixture = structuredClone(mutable);
    if (
      fixture.input.anchorSnapshot !== input.catalogSnapshot.version ||
      !input.catalogSnapshot.targets.includes(fixture.input.anchorTarget)
    ) {
      throw new Error(`fixture ${fixture.id} anchor is absent from catalog snapshot`);
    }
    const frozen = Object.freeze(fixture);
    const [control, treatment] = await Promise.all([
      input.adapters.control.execute({ arm: "control", fixture: frozen, manifest, catalogSnapshot: input.catalogSnapshot }),
      input.adapters.treatment.execute({ arm: "treatment", fixture: frozen, manifest, catalogSnapshot: input.catalogSnapshot }),
    ]);
    const inputFingerprint = createHash("sha256")
      .update(canonicalJson(fixture.input))
      .digest("hex");
    const shared = {
      inputFingerprint,
      anchorSnapshot: fixture.input.anchorSnapshot,
      anchorTarget: fixture.input.anchorTarget,
    };
    pairs.push({
      caseId: fixture.id,
      control: { ...shared, ...control },
      treatment: { ...shared, ...treatment },
    });
  }
  if (input.live) {
    if (input.runDir === undefined) throw new Error("live evaluation requires an untracked run directory");
    mkdirSync(input.runDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      resolve(input.runDir, "pairs.json"),
      `${JSON.stringify(pairs, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }
  return pairs;
}

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function registeredHash(): string {
  const register = parseYaml(
    readFileSync(resolve(repoRoot, "docs/evidence/claims.yaml"), "utf8"),
  ) as { claims: Array<{ id: string; fixtureSetSha256?: string }> };
  const value = register.claims.find(
    (claim) => claim.id === "P3-CODEX-PAIRED-UNSUPPORTED-CLAIM-RATE",
  )?.fixtureSetSha256;
  if (value === undefined) throw new Error("P3 frozen fixture hash is absent from claims register");
  return value;
}

export async function replayFrozenCases(fixtureDir: string): Promise<PairedEvaluation[]> {
  const fixtures = JSON.parse(readFileSync(resolve(fixtureDir, "cases.json"), "utf8")) as FrozenCase[];
  const first = fixtures[0];
  if (first === undefined) throw new Error("macro fixture set is empty");
  const manifest = parseTeamYaml(
    readFileSync(resolve(repoRoot, "teams/macro.yaml"), "utf8"),
  );
  const replay = (arm: "control" | "treatment"): EvaluationExecutorAdapter => ({
    execute: async ({ fixture }) => ({ state: "completed", ...fixture[arm] }),
  });
  return await runEvaluation({
    manifest,
    fixtures,
    catalogSnapshot: {
      version: first.input.anchorSnapshot,
      targets: [first.input.anchorTarget],
    },
    adapters: { control: replay("control"), treatment: replay("treatment") },
  });
}

export interface OfflineEvaluationReport {
  mode: "offline-replay";
  gate: ReturnType<typeof evaluatePairedGate>;
  autonomyRecords: AutonomyDecisionRecord[];
}

export async function runOfflineEvaluation(fixtureDir: string): Promise<OfflineEvaluationReport> {
  const gate = evaluatePairedGate({
    fixtureDir,
    expectedFixtureHash: registeredHash(),
    pairs: await replayFrozenCases(fixtureDir),
  });
  const autonomyInputs = JSON.parse(
    readFileSync(resolve(repoRoot, "evals/fixtures/routing/autonomy.json"), "utf8"),
  ) as AutonomyDecisionInput[];
  const autonomyRecords = autonomyInputs.map(decideAutonomy);
  const manifest = parseTeamYaml(
    readFileSync(resolve(repoRoot, "teams/macro.yaml"), "utf8"),
  );
  const taskIds = manifest.tasks.map((task) => task.id).sort();
  const decidedIds = autonomyRecords.map((record) => record.nodeId).sort();
  if (canonicalJson(taskIds) !== canonicalJson(decidedIds)) {
    throw new Error("every macro task must have exactly one autonomy decision record");
  }
  return { mode: "offline-replay", gate, autonomyRecords };
}

const invokedDirectly = process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
  const requested = argument("--fixtures") ?? "evals/fixtures/macro";
  const fixtureDir = resolve(repoRoot, requested);
  if (process.argv.includes("--fixture-hash")) {
    process.stdout.write(`${fixtureDirectoryHash(fixtureDir)}\n`);
  } else {
    if (process.argv.includes("--live") && process.env.HELIUM_EVAL_LIVE !== "1") {
      throw new Error("live evaluation requires HELIUM_EVAL_LIVE=1");
    }
    if (process.argv.includes("--live")) {
      throw new Error("live evaluation requires injected provider adapters; offline replay remains the default");
    }
    const result = await runOfflineEvaluation(fixtureDir);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.gate.passed) process.exitCode = 1;
  }
}
