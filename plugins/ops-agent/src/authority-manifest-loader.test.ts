import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { manifestSigningPayload, type SopDefinition } from "@helium/core";
import { describe, expect, it } from "vitest";
import {
  loadAuthoritySource,
  resolveSopAuthority,
} from "./authority-manifest-loader.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const digest = `sha256:${"a".repeat(64)}`;

const sop = (authority: SopDefinition["authority"]): SopDefinition =>
  ({
    version: 1,
    id: "fixture-auto",
    digest,
    componentId: "fixture-service",
    matches: { dimension: "readiness", failureClass: "failed" },
    authority,
    mutating: true,
    priority: 1,
    action: {
      executorId: "x",
      executable: { path: "/usr/bin/true" },
      argvSchemaId: "x",
      cwdId: "x",
      environmentProfileId: "x",
      timeoutMs: 1000,
    },
    preconditions: [],
    postconditions: ["c"],
    graceMs: 0,
    maxAttempts: 1,
    cooldownMs: 0,
  }) as SopDefinition;

function onDisk(entries: unknown[], opts: { key?: boolean; manifest?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "helium-ops-auth-"));
  const authorityManifestPath = join(dir, "authority-manifest.json");
  const trustedKeyPath = join(dir, "trusted.pem");
  if (opts.manifest !== false) {
    writeFileSync(
      authorityManifestPath,
      JSON.stringify({
        entries,
        signature: sign(
          null,
          manifestSigningPayload(entries as never),
          privateKey,
        ).toString("base64"),
      }),
    );
  }
  if (opts.key !== false) {
    writeFileSync(trustedKeyPath, publicKey.export({ type: "spki", format: "pem" }));
  }
  return { authorityManifestPath, trustedKeyPath };
}

describe("loadAuthoritySource", () => {
  it("loads a manifest and its trusted key", () => {
    const source = loadAuthoritySource(onDisk([]));
    expect(source.manifest?.entries).toEqual([]);
    expect(source.trustedKey).toBeDefined();
  });

  // A missing file is not an error: it is the fail-closed state.
  it("reports a missing manifest rather than throwing", () => {
    expect(loadAuthoritySource(onDisk([], { manifest: false }))).toEqual({
      unavailableReason: "manifest-missing",
    });
  });

  it("reports an unavailable trusted key rather than throwing", () => {
    expect(loadAuthoritySource(onDisk([], { key: false }))).toEqual({
      unavailableReason: "trusted-key-unavailable",
    });
  });

  it("reports unparseable manifest JSON as missing rather than crashing startup", () => {
    const paths = onDisk([]);
    writeFileSync(paths.authorityManifestPath, "{not json");
    expect(loadAuthoritySource(paths).unavailableReason).toBe("manifest-missing");
  });
});

describe("resolveSopAuthority", () => {
  it("grants a fully matching signed entry", () => {
    const source = loadAuthoritySource(
      onDisk([{ sopId: "fixture-auto", version: 1, digest, authority: "auto" }]),
    );
    expect(resolveSopAuthority(sop("auto"), source)).toEqual({
      authority: "auto",
      authorityManifestEntry: {
        sopId: "fixture-auto",
        version: 1,
        digest,
        authority: "auto",
      },
    });
  });

  it("downgrades to observe with a reason when the entry is missing", () => {
    expect(resolveSopAuthority(sop("auto"), loadAuthoritySource(onDisk([])))).toEqual({
      authority: "observe",
      authorityDowngradeReason: "manifest-entry-missing",
    });
  });

  // Observing is what a loaded SOP does by default. Requiring a signature to
  // do nothing would make the manifest an availability dependency for reading.
  it("needs no grant for observe or forbidden", () => {
    const none = { unavailableReason: "manifest-missing" };
    expect(resolveSopAuthority(sop("observe"), none)).toEqual({ authority: "observe" });
    expect(resolveSopAuthority(sop("forbidden"), none)).toEqual({
      authority: "forbidden",
    });
  });

  it("downgrades every above-observe claim when no manifest exists", () => {
    const none = loadAuthoritySource(onDisk([], { manifest: false }));
    for (const authority of ["auto", "approve"] as const) {
      expect(resolveSopAuthority(sop(authority), none)).toEqual({
        authority: "observe",
        authorityDowngradeReason: "manifest-missing",
      });
    }
  });
});

describe("the committed fixture manifest", () => {
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

  it("grants nothing, so no committed SOP can reach auto by accident", () => {
    const source = loadAuthoritySource({
      authorityManifestPath: join(repoRoot, "ops/authority-manifest.json"),
      trustedKeyPath: join(repoRoot, "ops/authority-manifest.pub.pem"),
    });
    expect(source.manifest?.entries).toEqual([]);
    expect(resolveSopAuthority(sop("auto"), source)).toEqual({
      authority: "observe",
      authorityDowngradeReason: "manifest-entry-missing",
    });
  });

  it("carries a signature that actually verifies against the committed key", () => {
    // Otherwise the fixture would be proving `manifest-signature-invalid`
    // rather than `manifest-entry-missing`, which is a different thing.
    const source = loadAuthoritySource({
      authorityManifestPath: join(repoRoot, "ops/authority-manifest.json"),
      trustedKeyPath: join(repoRoot, "ops/authority-manifest.pub.pem"),
    });
    expect(source.unavailableReason).toBeUndefined();
    expect(
      resolveSopAuthority(sop("auto"), source).authorityDowngradeReason,
    ).not.toBe("manifest-signature-invalid");
  });
});
