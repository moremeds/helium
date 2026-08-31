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
import { basename, dirname, join } from "node:path";
import {
  canonicalJson,
  ObservationSchema,
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
  hashArtifacts(refs: readonly string[]): EvidenceRef[];
  persistBundle(bundle: RecoveryEvidence): TerminalEvidenceRef;
  verifyEvent(event: OperationsEvent): void;
  verifyHistory(events: readonly OperationsEvent[]): void;
  readArtifact(ref: EvidenceRef): Buffer;
}

export class FileRecoveryEvidenceStore implements RecoveryEvidencePort {
  constructor(
    private readonly dir: string,
    private readonly options: {
      /** Test/fixture seam. Production resolves only artifact://ops/raw refs. */
      readSourceArtifact?: (ref: string) => string | Buffer;
      /** Production extension for exact component-owned content-addressed inputs. */
      readAdditionalSourceArtifact?: (ref: string) => string | Buffer;
    } = {},
  ) {
    ensurePrivateDirectory(dir);
  }

  persistArtifact(kind: string, value: unknown): EvidenceRef {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(kind)) {
      throw new Error(`invalid evidence artifact kind: ${kind}`);
    }
    return this.#persist(`${kind}`, canonicalJson(value));
  }

  hashArtifacts(refs: readonly string[]): EvidenceRef[] {
    return this.#rawSourceRefs(refs).map((ref) => {
      const raw = this.#readSource(ref);
      return {
        ref,
        sha256: createHash("sha256").update(raw).digest("hex"),
      };
    });
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

  readArtifact(ref: EvidenceRef): Buffer {
    return Buffer.from(this.#read(ref));
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
    const observationValues = bundle.observations.map((nested) =>
      ObservationSchema.parse(JSON.parse(this.#read(nested))));
    for (const nested of [
      bundle.incidentSnapshot,
      ...(bundle.receipt === undefined ? [] : [bundle.receipt.evidence]),
    ]) {
      this.#read(nested);
    }
    const expectedSources = this.#rawSourceRefs([
      ...observationValues.flatMap((observation) => observation.evidenceRefs),
      bundle.controllerProbe.evidenceRef,
      ...(bundle.baseline === undefined
        ? []
        : bundle.baseline.samples.flatMap((sample) => sample.evidenceRefs)),
      ...bundle.postconditionSamples.flatMap((sample) => sample.evidenceRefs),
    ]);
    const actualSources = [...new Set(bundle.rawArtifacts.map((artifact) => artifact.ref))].sort();
    if (canonicalJson(actualSources) !== canonicalJson(expectedSources)) {
      throw new Error(`recovery evidence raw artifact set mismatch: ${event.actionId}`);
    }
    for (const artifact of bundle.rawArtifacts) {
      const actual = createHash("sha256").update(this.#readSource(artifact.ref)).digest("hex");
      if (actual !== artifact.sha256) {
        throw new Error(`raw evidence hash mismatch: ${artifact.ref}`);
      }
    }
    for (const artifact of bundle.intent?.inputArtifacts ?? []) {
      const actual = createHash("sha256").update(this.#readSource(artifact.ref)).digest("hex");
      if (actual !== artifact.sha256) {
        throw new Error(`scoped input artifact hash mismatch: ${artifact.ref}`);
      }
    }
  }

  #rawSourceRefs(refs: readonly string[]): string[] {
    const unique = [...new Set(refs)].sort();
    if (this.options.readSourceArtifact !== undefined) return unique;
    return unique.filter((ref) => {
      if (ref.startsWith("artifact://ops/raw/")) return true;
      if (ref.startsWith("artifact://sha256/") &&
          this.options.readAdditionalSourceArtifact !== undefined) return true;
      const authority = ref.match(/^artifact:\/\/ops\/authority\/([a-zA-Z0-9._-]+)$/);
      if (authority !== null) return false;
      const unavailable = ref.match(
        /^artifact:\/\/ops\/check-unavailable\/(baseline|postcondition)\/([a-zA-Z0-9._-]+)$/,
      );
      if (unavailable !== null) return false;
      throw new Error(`unsupported raw evidence ref: ${ref}`);
    });
  }

  #readSource(ref: string): string | Buffer {
    if (this.options.readSourceArtifact !== undefined) {
      return this.options.readSourceArtifact(ref);
    }
    if (ref.startsWith("artifact://sha256/") &&
        this.options.readAdditionalSourceArtifact !== undefined) {
      return this.options.readAdditionalSourceArtifact(ref);
    }
    const prefix = "artifact://ops/raw/";
    if (!ref.startsWith(prefix)) throw new Error(`unsupported raw evidence ref: ${ref}`);
    const name = ref.slice(prefix.length);
    if (name === "" || basename(name) !== name) {
      throw new Error(`unsafe raw evidence ref: ${ref}`);
    }
    const rawDir = join(dirname(this.dir), "raw");
    const root = statSync(rawDir);
    if (!root.isDirectory() || (root.mode & 0o077) !== 0) {
      throw new Error(`raw evidence directory must be owner-only: ${rawDir}`);
    }
    if (typeof process.getuid === "function" && root.uid !== process.getuid()) {
      throw new Error(`raw evidence directory has a different owner: ${rawDir}`);
    }
    const path = join(rawDir, name);
    let file;
    try {
      file = lstatSync(path);
    } catch {
      throw new Error(`missing raw evidence artifact: ${ref}`);
    }
    if (!file.isFile() || (file.mode & 0o077) !== 0) {
      throw new Error(`raw evidence artifact must be owner-only: ${ref}`);
    }
    if (typeof process.getuid === "function" && file.uid !== process.getuid()) {
      throw new Error(`raw evidence artifact has a different owner: ${ref}`);
    }
    return readFileSync(path);
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
