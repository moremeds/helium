/** Bind one REPAIR_READY Shepherd work unit to the certified Ops transaction. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CheckDefinition, ComponentSpec } from "@helium/core";
import {
  CertifiedActionRunner,
  type CertifiedActionHooks,
  type CertifiedActionResult,
} from "dsh-plugin-ops-agent";
import { z } from "zod";
import type { WorkUnitProjection } from "./reducer.js";
import { ShepherdWorkUnitSchema, type HashedArtifactRef } from "./work-unit.js";

const HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const ManifestSchema = z.strictObject({
  version: z.literal(1),
  operationId: z.string().min(1).max(128),
  workUnitId: z.string().regex(/^lws-[0-9a-f]{32}$/),
  scopeHash: HashSchema,
  dataLakeRoot: z.string().min(1).max(2_000),
  layer: z.literal("bronze"),
  securityId: z.string().regex(/^sec_[0-9a-f]{32}$/),
  symbol: z.string().min(1).max(64),
  symbolValidFrom: z.iso.datetime(),
  symbolValidTo: z.iso.datetime().nullable(),
  identityAsOf: z.iso.datetime(),
  securityMasterRevision: z.number().int().positive(),
  securityMasterSha256: z.string().regex(/^[0-9a-f]{64}$/),
  sessionPolicy: z.literal("XNYS-close-and-early-close-v2"),
  dateFrom: z.iso.date(),
  dateTo: z.iso.date(),
  timeframe: z.literal("1d"),
  priorArtifacts: z.array(z.strictObject({
    path: z.string().min(1).max(2_000),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })).length(1),
  sourceEvidence: z.array(z.strictObject({
    ref: z.string().min(1).max(2_000),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  })).length(1),
  maxRows: z.number().int().positive(),
  maxBytes: z.number().int().positive(),
  expiresAt: z.iso.datetime(),
  operation: z.literal("daily-merge"),
});

export interface ResolvedRepairManifest {
  path: string;
  hash: `sha256:${string}`;
  evidence: HashedArtifactRef;
}

export interface ShepherdRepairControllerOptions {
  readyDir: string;
  dataLakeRoots: readonly string[];
  runner: CertifiedActionRunner;
  component: ComponentSpec;
  sop: {
    id: string;
    digest: `sha256:${string}`;
    executorId: string;
    graceMs: number;
    postconditions: readonly CheckDefinition[];
  };
  now: () => Date;
  /** Signed capability check, separate from manifest/work-unit validation. */
  authorizeArgv(argv: readonly string[]): void;
  verifyEvidence(evidence: HashedArtifactRef): void;
  hooksFor(context: {
    actionId: string;
    incidentId: string;
    scopeId: string;
    manifest: ResolvedRepairManifest;
    workUnit: WorkUnitProjection;
  }): CertifiedActionHooks;
  dependencyIds?: () => readonly string[];
}

export interface ShepherdRepairRunResult extends CertifiedActionResult {
  actionId: string;
  incidentId: string;
  scopeId: string;
  manifest: ResolvedRepairManifest;
}

export class ShepherdRepairController {
  constructor(private readonly options: ShepherdRepairControllerOptions) {
    if (!isAbsolute(options.readyDir)) throw new Error("Shepherd ready directory must be absolute");
    if (options.dataLakeRoots.length === 0 || options.dataLakeRoots.some((root) => !isAbsolute(root))) {
      throw new Error("Shepherd repair requires at least one absolute data-lake root");
    }
  }

  async run(
    projection: WorkUnitProjection,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ShepherdRepairRunResult> {
    const unit = ShepherdWorkUnitSchema.parse(projection.unit);
    if (projection.state !== "REPAIR_READY") {
      throw new Error(`Shepherd work unit is not repair-ready: ${projection.state}`);
    }
    if (unit.scope.kind !== "security-interval" || unit.scope.layer !== "bronze" || unit.scope.timeframe !== "1d") {
      throw new Error("Shepherd daily repair requires one Bronze security interval");
    }
    const manifest = this.#resolveManifest(projection);
    const argv = ["--manifest", manifest.path];
    this.options.authorizeArgv(argv);
    const scopeId = `${unit.workUnitId}:${unit.scopeHash}`;
    const attempt = Object.keys(projection.attempts).length + 1;
    const actionId = stableId("act", `${scopeId}|${this.options.sop.digest}|${attempt}`);
    const incidentId = stableId("inc", scopeId);
    const hooks = this.options.hooksFor({ actionId, incidentId, scopeId, manifest, workUnit: projection });
    const result = await this.options.runner.run(
      {
        scopeId,
        actionId,
        attempt,
        incidentId,
        component: this.options.component,
        sop: {
          id: this.options.sop.id,
          digest: this.options.sop.digest,
          executorId: this.options.sop.executorId,
          postconditions: this.options.sop.postconditions.map((check) => check.id),
        },
        argv,
        verificationPolicy: {
          postconditions: this.options.sop.postconditions,
          graceMs: this.options.sop.graceMs,
        },
        eligibility: { eligible: true, reasons: [] },
        mutationOwner: this.options.component.mutationOwner,
        inputArtifacts: [{
          ref: manifest.evidence.ref,
          sha256: manifest.evidence.hash.slice("sha256:".length),
        }],
        dependencyIds: this.options.dependencyIds ?? (() => []),
        preSpawn: () => {
          this.options.authorizeArgv(argv);
          this.#verifyUnchanged(projection, manifest);
        },
      },
      hooks,
      signal,
    );
    return { ...result, actionId, incidentId, scopeId, manifest };
  }

  #resolveManifest(projection: WorkUnitProjection): ResolvedRepairManifest {
    const readyRoot = realpathSync(this.options.readyDir);
    const rootStat = lstatSync(readyRoot);
    if (!rootStat.isDirectory() || (rootStat.mode & 0o077) !== 0 || rootStat.uid !== process.getuid?.()) {
      throw new Error("Shepherd ready directory is not private to the daemon owner");
    }
    const path = join(readyRoot, repairManifestFilename(projection.unit.scopeHash));
    const stat = lstatSync(path);
    if (
      !stat.isFile() || stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()
    ) {
      throw new Error("Shepherd repair manifest is not a private regular file owned by the daemon user");
    }
    const resolved = realpathSync(path);
    const fromRoot = relative(readyRoot, resolved);
    if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error("Shepherd repair manifest escapes the ready directory");
    }
    const bytes = readFileSync(resolved);
    const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const;
    const evidence = Object.values(projection.evidence).find((candidate) => candidate.hash === hash);
    if (evidence === undefined) throw new Error("Shepherd repair manifest bytes are absent from durable evidence");
    this.options.verifyEvidence(evidence);
    const manifest = ManifestSchema.parse(JSON.parse(bytes.toString("utf8")));
    this.#verifyBinding(projection, manifest);
    if (Date.parse(manifest.expiresAt) <= this.options.now().getTime()) {
      throw new Error("Shepherd repair manifest is expired");
    }
    return { path: resolved, hash, evidence };
  }

  #verifyUnchanged(projection: WorkUnitProjection, expected: ResolvedRepairManifest): void {
    const current = this.#resolveManifest(projection);
    if (current.path !== expected.path || current.hash !== expected.hash || current.evidence.ref !== expected.evidence.ref) {
      throw new Error("Shepherd repair manifest changed at the execution boundary");
    }
  }

  #verifyBinding(projection: WorkUnitProjection, manifest: z.infer<typeof ManifestSchema>): void {
    const unit = projection.unit;
    const scope = unit.scope;
    if (scope.kind !== "security-interval") throw new Error("Shepherd repair scope is not a security interval");
    const matches =
      manifest.workUnitId === unit.workUnitId &&
      manifest.scopeHash === unit.scopeHash &&
      manifest.securityId === scope.securityId &&
      manifest.symbol === scope.symbol &&
      manifest.symbolValidFrom === scope.symbolValidFrom &&
      manifest.symbolValidTo === (scope.symbolValidTo ?? null) &&
      manifest.dateFrom === scope.dateFrom &&
      manifest.dateTo === scope.dateTo &&
      manifest.timeframe === scope.timeframe &&
      manifest.layer === scope.layer;
    if (!matches) throw new Error("Shepherd repair manifest does not match the exact work-unit scope");
    if (!this.options.dataLakeRoots.some((root) => resolve(root) === resolve(manifest.dataLakeRoot))) {
      throw new Error("Shepherd repair manifest names an unconfigured data-lake root");
    }
  }
}

export function repairManifestFilename(scopeHash: string): string {
  return `${HashSchema.parse(scopeHash)}.json`;
}

function stableId(prefix: string, value: string): string {
  return `${prefix}-${createHash("sha256").update(value).digest("hex")}`;
}
