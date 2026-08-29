/** Durable, content-addressed recovery evidence for terminal action assertions. */
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
  canonicalJson,
  RecoveryEvidenceSchema,
  type EvidenceRef,
  type OperationsEvent,
  type RecoveryEvidence,
} from "@helium/core";

export const RECOVERY_EVIDENCE_SCHEMA = "helium.ops.recovery-evidence/v1" as const;

export interface TerminalEvidenceRef extends EvidenceRef {
  schema: typeof RECOVERY_EVIDENCE_SCHEMA;
  assertionId: string;
}

export interface RecoveryEvidencePort {
  persistArtifact(kind: string, value: unknown): EvidenceRef;
  persistBundle(bundle: RecoveryEvidence): TerminalEvidenceRef;
  verifyEvent(event: OperationsEvent): void;
  verifyHistory(events: readonly OperationsEvent[]): void;
}

export class FileRecoveryEvidenceStore implements RecoveryEvidencePort {
  constructor(private readonly dir: string) {
    ensurePrivateDirectory(dir);
  }

  persistArtifact(kind: string, value: unknown): EvidenceRef {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(kind)) {
      throw new Error(`invalid evidence artifact kind: ${kind}`);
    }
    return this.#persist(`${kind}`, canonicalJson(value));
  }

  persistBundle(raw: RecoveryEvidence): TerminalEvidenceRef {
    const bundle = RecoveryEvidenceSchema.parse(raw);
    const persisted = this.#persist("recovery", canonicalJson(bundle));
    return {
      ...persisted,
      schema: RECOVERY_EVIDENCE_SCHEMA,
      assertionId: bundle.assertionId,
    };
  }

  verifyHistory(events: readonly OperationsEvent[]): void {
    for (const event of events) {
      this.verifyEvent(event);
    }
  }

  verifyEvent(event: OperationsEvent): void {
    if (event.type !== "action-verified") return;
    const raw = this.#read(event.recoveryEvidence);
    const bundle = RecoveryEvidenceSchema.parse(JSON.parse(raw));
    if (bundle.assertionId !== event.recoveryEvidence.assertionId) {
      throw new Error(`recovery evidence assertion mismatch: ${event.actionId}`);
    }
    if (bundle.outcome !== event.outcome) {
      throw new Error(`recovery evidence outcome mismatch: ${event.actionId}`);
    }
    if (bundle.attribution !== event.attribution) {
      throw new Error(`recovery evidence attribution mismatch: ${event.actionId}`);
    }
    if (bundle.intent !== undefined && bundle.intent.actionId !== event.actionId) {
      throw new Error(`recovery evidence action mismatch: ${event.actionId}`);
    }
    if (bundle.assertionId !== `recovery-${event.actionId}`) {
      throw new Error(`recovery evidence assertion does not name action: ${event.actionId}`);
    }
    if (canonicalJson(bundle.postconditionSamples) !== canonicalJson(event.postconditionSamples)) {
      throw new Error(`recovery evidence postcondition samples mismatch: ${event.actionId}`);
    }
    if (canonicalJson(event.postconditionRefs) !==
        canonicalJson(bundle.postconditionSamples.map((sample) => sample.checkId))) {
      throw new Error(`recovery evidence postcondition refs mismatch: ${event.actionId}`);
    }
    for (const nested of [
      ...bundle.observations,
      bundle.incidentSnapshot,
      ...(bundle.receipt === undefined ? [] : [bundle.receipt.evidence]),
    ]) {
      this.#read(nested);
    }
  }

  #persist(kind: string, body: string): EvidenceRef {
    const sha256 = createHash("sha256").update(body).digest("hex");
    const name = `${kind}-${sha256}.json`;
    const target = join(this.dir, name);
    if (existsSync(target)) {
      const ref = { ref: `artifact://ops/evidence/${name}`, sha256 };
      const existing = this.#read(ref);
      if (existing !== body) throw new Error(`evidence hash collision: ${name}`);
      return ref;
    }

    const staging = join(this.dir, `.${name}.${process.pid}.tmp`);
    const fd = openSync(staging, "wx", 0o600);
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(staging, target);
    const dirFd = openSync(this.dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
    return { ref: `artifact://ops/evidence/${name}`, sha256 };
  }

  #read(ref: EvidenceRef): string {
    const prefix = "artifact://ops/evidence/";
    if (!ref.ref.startsWith(prefix)) throw new Error(`unsupported evidence ref: ${ref.ref}`);
    const name = ref.ref.slice(prefix.length);
    if (name === "" || basename(name) !== name) {
      throw new Error(`unsafe evidence ref: ${ref.ref}`);
    }
    const path = join(this.dir, name);
    let raw: string;
    try {
      const stat = lstatSync(path);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
        throw new Error(`recovery evidence artifact must be owner-only: ${ref.ref}`);
      }
      if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
        throw new Error(`recovery evidence artifact has a different owner: ${ref.ref}`);
      }
      raw = readFileSync(path, "utf8");
    } catch (error) {
      if (error instanceof Error && /recovery evidence artifact/.test(error.message)) {
        throw error;
      }
      throw new Error(`missing recovery evidence artifact: ${ref.ref}`);
    }
    const actual = createHash("sha256").update(raw).digest("hex");
    if (actual !== ref.sha256) throw new Error(`recovery evidence hash mismatch: ${ref.ref}`);
    return raw;
  }
}

function ensurePrivateDirectory(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = statSync(dir);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) {
    throw new Error(`evidence directory must be owner-only: ${dir}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`evidence directory has a different owner: ${dir}`);
  }
}
