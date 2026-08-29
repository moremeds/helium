import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  manifestSigningPayload,
  resolveAuthority,
  type AuthorityManifestEntry,
  type SignedAuthorityManifest,
  type SopFileClaim,
} from "../src/operations/authority-manifest.js";

const { publicKey: trustedKey, privateKey } = generateKeyPairSync("ed25519");
const { publicKey: otherPublic, privateKey: otherPrivate } =
  generateKeyPairSync("ed25519");

const digest = `sha256:${"a".repeat(64)}`;

const autoSopFile: SopFileClaim = {
  id: "repair-coverage",
  version: 2,
  digest,
  authority: "auto",
};

const signManifest = (
  entries: AuthorityManifestEntry[],
  key = privateKey,
): SignedAuthorityManifest => ({
  entries,
  signature: sign(null, manifestSigningPayload(entries), key).toString("base64"),
});

const entry = (
  overrides: Partial<AuthorityManifestEntry> = {},
): AuthorityManifestEntry => ({
  sopId: "repair-coverage",
  version: 2,
  digest,
  authority: "auto",
  ...overrides,
});

describe("resolveAuthority", () => {
  it("returns the file's authority for a matching entry under a verifying signature", () => {
    expect(
      resolveAuthority(autoSopFile, signManifest([entry()]), trustedKey),
    ).toEqual({
      authority: "auto",
      manifestEntry: expect.objectContaining({ digest }),
    });
  });

  it.each([
    ["no manifest is present", undefined, "manifest-missing"],
  ])("falls back to observe when %s", (_label, manifest, reason) => {
    expect(resolveAuthority(autoSopFile, manifest, trustedKey)).toMatchObject({
      authority: "observe",
      reason,
    });
  });

  it("falls back to observe when the signature does not verify", () => {
    const tampered = signManifest([entry()]);
    tampered.entries = [entry({ authority: "auto", version: 2 }), entry({ sopId: "sneaked-in" })];
    expect(resolveAuthority(autoSopFile, tampered, trustedKey)).toMatchObject({
      authority: "observe",
      reason: "manifest-signature-invalid",
    });
  });

  it("falls back to observe when the manifest was signed by an untrusted key", () => {
    expect(
      resolveAuthority(autoSopFile, signManifest([entry()], otherPrivate), trustedKey),
    ).toMatchObject({ authority: "observe", reason: "manifest-signature-invalid" });
    // ...and the same manifest verifies fine against the key that signed it,
    // which is what proves the refusal is about trust, not about encoding.
    expect(
      resolveAuthority(autoSopFile, signManifest([entry()], otherPrivate), otherPublic),
    ).toMatchObject({ authority: "auto" });
  });

  it("falls back to observe when the manifest does not list the SOP", () => {
    expect(
      resolveAuthority(
        autoSopFile,
        signManifest([entry({ sopId: "some-other-sop" })]),
        trustedKey,
      ),
    ).toMatchObject({ authority: "observe", reason: "manifest-entry-missing" });
  });

  it("falls back to observe on a digest mismatch", () => {
    expect(
      resolveAuthority(
        autoSopFile,
        signManifest([entry({ digest: `sha256:${"b".repeat(64)}` })]),
        trustedKey,
      ),
    ).toMatchObject({ authority: "observe", reason: "manifest-digest-mismatch" });
  });

  it("falls back to observe on a version mismatch", () => {
    expect(
      resolveAuthority(autoSopFile, signManifest([entry({ version: 1 })]), trustedKey),
    ).toMatchObject({ authority: "observe", reason: "manifest-version-mismatch" });
  });

  // The point of the whole suite. An SOP file can be edited; the manifest
  // cannot, without the key.
  it("refuses an SOP that edited its own authority upward, leaving the manifest untouched", () => {
    const certifiedApprove = signManifest([entry({ authority: "approve" })]);
    const escalated: SopFileClaim = { ...autoSopFile, authority: "auto" };
    expect(resolveAuthority(escalated, certifiedApprove, trustedKey)).toMatchObject({
      authority: "observe",
      reason: "manifest-authority-escalation",
    });
    // The unedited file still resolves to what it was certified for.
    expect(
      resolveAuthority(
        { ...autoSopFile, authority: "approve" },
        certifiedApprove,
        trustedKey,
      ),
    ).toMatchObject({ authority: "approve" });
  });

  it("refuses a file claiming LESS than the manifest grants, as a mismatch not an escalation", () => {
    expect(
      resolveAuthority(
        { ...autoSopFile, authority: "approve" },
        signManifest([entry({ authority: "auto" })]),
        trustedKey,
      ),
    ).toMatchObject({ authority: "observe", reason: "manifest-authority-mismatch" });
  });

  it("never throws on a malformed signature; it returns observe", () => {
    expect(
      resolveAuthority(
        autoSopFile,
        { entries: [entry()], signature: "not-base64-!!!" },
        trustedKey,
      ),
    ).toMatchObject({ authority: "observe", reason: "manifest-signature-invalid" });
  });

  it("signs over canonical JSON, so key order in the entries cannot change the signature", () => {
    const ordered = [{ sopId: "s", version: 1, digest, authority: "auto" as const }];
    const shuffled = [{ authority: "auto" as const, digest, version: 1, sopId: "s" }];
    expect(manifestSigningPayload(ordered)).toEqual(manifestSigningPayload(shuffled));
  });
});
