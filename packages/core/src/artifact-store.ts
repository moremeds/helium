/** Owner-only content-addressed byte storage shared by teams and Shepherd. */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const HASH = /^sha256:[0-9a-f]{64}$/;
const REF = /^artifact:\/\/sha256\/([0-9a-f]{64})$/;

export type Sha256Hash = `sha256:${string}`;

export interface StoredArtifact {
  ref: string;
  hash: Sha256Hash;
  size: number;
}

export interface ContentAddressedArtifactStoreOptions {
  sync?: (fd: number) => void;
}

export class ContentAddressedArtifactStore {
  readonly #root: string;
  readonly #sync: (fd: number) => void;

  constructor(root: string, options: ContentAddressedArtifactStoreOptions = {}) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    assertOwnerOnlyDirectory(root);
    this.#root = root;
    this.#sync = options.sync ?? fsyncSync;
  }

  put(content: string | Uint8Array, declaredHash?: string): StoredArtifact {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const actualHash = digest(bytes);
    if (declaredHash !== undefined) {
      assertHash(declaredHash);
      if (declaredHash !== actualHash) {
        throw new Error(
          `artifact content hash mismatch: declared ${declaredHash}, actual ${actualHash}`,
        );
      }
    }

    const destination = this.#path(actualHash);
    if (existsSync(destination)) {
      const stored = this.#readVerified(actualHash);
      return descriptor(actualHash, stored.byteLength);
    }

    const temporary = join(
      this.#root,
      `.${actualHash.slice("sha256:".length)}.${randomUUID()}.tmp`,
    );
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, bytes);
      this.#sync(fd);
    } finally {
      closeSync(fd);
    }

    try {
      linkSync(temporary, destination);
      const directoryFd = openSync(this.#root, "r");
      try {
        this.#sync(directoryFd);
      } finally {
        closeSync(directoryFd);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      this.#readVerified(actualHash);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }

    const stored = this.#readVerified(actualHash);
    return descriptor(actualHash, stored.byteLength);
  }

  read(ref: string): Buffer {
    return this.#readVerified(hashFromRef(ref));
  }

  verify(ref: string, declaredHash?: string): StoredArtifact {
    const hash = hashFromRef(ref);
    if (declaredHash !== undefined) {
      assertHash(declaredHash);
      if (declaredHash !== hash) {
        throw new Error(
          `artifact identity mismatch: reference ${hash}, declared ${declaredHash}`,
        );
      }
    }
    const bytes = this.#readVerified(hash);
    return descriptor(hash, bytes.byteLength);
  }

  #path(hash: Sha256Hash): string {
    return join(this.#root, hash.slice("sha256:".length));
  }

  #readVerified(hash: Sha256Hash): Buffer {
    const path = this.#path(hash);
    assertOwnerOnlyFile(path);
    const bytes = readFileSync(path);
    const actualHash = digest(bytes);
    if (actualHash !== hash) {
      throw new Error(
        `artifact content hash mismatch: declared ${hash}, actual ${actualHash}`,
      );
    }
    return bytes;
  }
}

function digest(content: Uint8Array): Sha256Hash {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function descriptor(hash: Sha256Hash, size: number): StoredArtifact {
  return {
    ref: `artifact://sha256/${hash.slice("sha256:".length)}`,
    hash,
    size,
  };
}

function hashFromRef(ref: string): Sha256Hash {
  const match = REF.exec(ref);
  if (match === null) throw new Error(`invalid artifact reference: ${ref}`);
  return `sha256:${match[1]}`;
}

function assertHash(hash: string): asserts hash is Sha256Hash {
  if (!HASH.test(hash)) throw new Error(`invalid artifact hash: ${hash}`);
}

function assertOwnerOnlyDirectory(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isDirectory()) throw new Error(`${path}: artifact root must be a directory`);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${path}: artifact root must be owner-only (0700)`);
  }
  assertOwner(path, stat.uid);
}

function assertOwnerOnlyFile(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error(`${path}: artifact content must be a regular file`);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`${path}: artifact content must be owner-only (0600)`);
  }
  assertOwner(path, stat.uid);
}

function assertOwner(path: string, uid: number): void {
  if (typeof process.getuid === "function" && uid !== process.getuid()) {
    throw new Error(`${path}: artifact path has a different owner`);
  }
}
