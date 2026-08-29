/**
 * The signed authority manifest: the only thing that can grant an SOP file
 * more than `observe`.
 *
 * An SOP file states an authority. That statement is a CLAIM, not a grant --
 * anyone who can edit the file can edit the claim. The manifest is the grant,
 * and it is signed, so escalating an SOP by editing one field in its own file
 * gets you `observe`, not `auto`.
 *
 * Pure verifier: canonical-JSON encode, Ed25519 verify against an INJECTED
 * trusted public key, then match the entry. It performs no I/O and holds no
 * key material; loading and key configuration belong to the daemon.
 *
 * The canonical-JSON encoder is the one the event store already uses, and the
 * Ed25519 helper here is the one the operator approval envelope reuses. One
 * signing scheme, one algorithm, one key -- a second would be a second thing
 * to get wrong.
 * @module @helium/core/operations/authority-manifest
 */
import { verify, type KeyObject } from "node:crypto";
import { canonicalJson } from "../event-store.js";
import { SOP_AUTHORITIES, type SopAuthority } from "./sop.js";

/** How much a level grants. `forbidden` grants nothing and is not a rank. */
const AUTHORITY_RANK: Readonly<Record<SopAuthority, number>> = {
  forbidden: -1,
  observe: 0,
  approve: 1,
  auto: 2,
};

export interface AuthorityManifestEntry {
  sopId: string;
  version: number;
  digest: string;
  authority: SopAuthority;
}

export interface SignedAuthorityManifest {
  entries: AuthorityManifestEntry[];
  /** Base64 Ed25519 signature over the canonical JSON of `entries`. */
  signature: string;
}

/** The fields of a loaded SOP file this verifier reads. */
export interface SopFileClaim {
  id: string;
  version: number;
  digest: string;
  authority: SopAuthority;
}

export type AuthorityResolution =
  | { authority: SopAuthority; manifestEntry: AuthorityManifestEntry }
  | { authority: "observe"; reason: string };

/** The bytes a manifest signature covers. Exported so the signer cannot drift. */
export function manifestSigningPayload(
  entries: AuthorityManifestEntry[],
): Buffer {
  return Buffer.from(canonicalJson(entries), "utf8");
}

/** Ed25519 verification. The one helper; do not add a second scheme. */
export function verifyManifestSignature(
  manifest: SignedAuthorityManifest,
  trustedKey: KeyObject,
): boolean {
  let signature: Buffer;
  try {
    signature = Buffer.from(manifest.signature, "base64");
  } catch {
    return false;
  }
  try {
    return verify(
      null,
      manifestSigningPayload(manifest.entries),
      trustedKey,
      signature,
    );
  } catch {
    // A malformed key or signature is a failed verification, never a throw
    // that a caller might catch and treat as "unknown, proceed".
    return false;
  }
}

/**
 * Resolve the authority an SOP file actually holds.
 *
 * Returns `observe` -- fail-closed, with a named reason -- for every one of:
 * no manifest, a signature that does not verify, an SOP the manifest does not
 * list, a digest mismatch, a version mismatch, or an authority that does not
 * match the entry. Only an entry matching `sopId`, `version`, `digest` AND
 * `authority` under a verifying signature returns the file's authority.
 */
export function resolveAuthority(
  sopFile: SopFileClaim,
  manifest: SignedAuthorityManifest | undefined,
  trustedKey: KeyObject,
): AuthorityResolution {
  if (manifest === undefined) {
    return { authority: "observe", reason: "manifest-missing" };
  }
  if (!verifyManifestSignature(manifest, trustedKey)) {
    return { authority: "observe", reason: "manifest-signature-invalid" };
  }

  const entry = manifest.entries.find((e) => e.sopId === sopFile.id);
  if (entry === undefined) {
    return { authority: "observe", reason: "manifest-entry-missing" };
  }
  if (entry.version !== sopFile.version) {
    return { authority: "observe", reason: "manifest-version-mismatch" };
  }
  if (entry.digest !== sopFile.digest) {
    return { authority: "observe", reason: "manifest-digest-mismatch" };
  }
  if (entry.authority !== sopFile.authority) {
    // Naming the escalation case separately matters: it is the difference
    // between a stale manifest and someone editing an SOP to grant itself
    // more authority than it was certified for.
    const escalating =
      AUTHORITY_RANK[sopFile.authority] > AUTHORITY_RANK[entry.authority];
    return {
      authority: "observe",
      reason: escalating
        ? "manifest-authority-escalation"
        : "manifest-authority-mismatch",
    };
  }
  if (!SOP_AUTHORITIES.includes(entry.authority)) {
    return { authority: "observe", reason: "manifest-authority-unknown" };
  }

  return { authority: entry.authority, manifestEntry: entry };
}
