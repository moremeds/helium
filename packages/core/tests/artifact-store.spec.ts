import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ContentAddressedArtifactStore } from "../src/artifact-store.js";

const noSync = () => {};
const sha256 = (content: string) =>
  `sha256:${createHash("sha256").update(content).digest("hex")}` as const;

function freshRoot(): string {
  const parent = mkdtempSync(join(tmpdir(), "helium-cas-"));
  return join(parent, "artifacts");
}

describe("ContentAddressedArtifactStore", () => {
  it("persists bytes by their declared sha256 and reopens them", () => {
    const root = freshRoot();
    const store = new ContentAddressedArtifactStore(root, { sync: noSync });

    const saved = store.put(Buffer.from("alpha"), sha256("alpha"));

    expect(saved.ref).toBe(`artifact://sha256/${sha256("alpha").slice(7)}`);
    expect(saved.hash).toBe(sha256("alpha"));
    expect(saved.size).toBe(5);
    expect(new ContentAddressedArtifactStore(root, { sync: noSync }).read(saved.ref))
      .toEqual(Buffer.from("alpha"));
  });

  it("rejects a declared hash mismatch and detects later tampering", () => {
    const root = freshRoot();
    const store = new ContentAddressedArtifactStore(root, { sync: noSync });
    expect(() => store.put("alpha", sha256("beta"))).toThrow(/hash mismatch/i);

    const saved = store.put("alpha");
    writeFileSync(join(root, saved.hash.slice("sha256:".length)), "tampered");

    expect(() => store.read(saved.ref)).toThrow(/hash mismatch/i);
    expect(() => store.verify(saved.ref)).toThrow(/hash mismatch/i);
  });

  it("uses owner-only directories and files", () => {
    const root = freshRoot();
    const store = new ContentAddressedArtifactStore(root, { sync: noSync });
    const saved = store.put("alpha");

    expect(lstatSync(root).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(root, saved.hash.slice("sha256:".length))).mode & 0o777)
      .toBe(0o600);
  });

  it("is idempotent for identical bytes and rejects a mismatched declared identity", () => {
    const root = freshRoot();
    const store = new ContentAddressedArtifactStore(root, { sync: noSync });
    const first = store.put("alpha");
    const second = store.put(Buffer.from("alpha"), first.hash);

    expect(second).toEqual(first);
    expect(() => store.verify(first.ref, sha256("beta"))).toThrow(/identity mismatch/i);
  });

  it("accepts only canonical content-addressed references", () => {
    const store = new ContentAddressedArtifactStore(freshRoot(), { sync: noSync });

    for (const ref of [
      "artifact://case/source.json",
      "artifact://sha256/ABC",
      "artifact://sha256/../escape",
      `artifact://sha256/${"a".repeat(63)}`,
    ]) {
      expect(() => store.read(ref)).toThrow(/invalid artifact reference/i);
    }
  });

  it("refuses a symlink or non-regular content destination", () => {
    const root = freshRoot();
    const store = new ContentAddressedArtifactStore(root, { sync: noSync });
    const hash = sha256("alpha");
    const destination = join(root, hash.slice("sha256:".length));
    const outside = join(mkdtempSync(join(tmpdir(), "helium-cas-outside-")), "bytes");
    writeFileSync(outside, "alpha");
    symlinkSync(outside, destination);

    expect(() => store.put("alpha", hash)).toThrow(/regular file/i);

    const directoryHash = sha256("directory");
    mkdirSync(join(root, directoryHash.slice("sha256:".length)));
    expect(() => store.verify(`artifact://sha256/${directoryHash.slice(7)}`))
      .toThrow(/regular file/i);
  });

  it("refuses a symlinked or broadly accessible root", () => {
    const parent = mkdtempSync(join(tmpdir(), "helium-cas-root-"));
    const actual = join(parent, "actual");
    mkdirSync(actual, { mode: 0o700 });
    const linked = join(parent, "linked");
    symlinkSync(actual, linked);
    expect(() => new ContentAddressedArtifactStore(linked)).toThrow(/directory/i);

    const broad = join(parent, "broad");
    mkdirSync(broad, { mode: 0o700 });
    chmodSync(broad, 0o755);
    expect(() => new ContentAddressedArtifactStore(broad)).toThrow(/owner-only/i);
  });
});
