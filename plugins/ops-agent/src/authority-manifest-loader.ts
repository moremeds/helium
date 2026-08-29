/**
 * Loads the signed authority manifest and resolves what each SOP file may
 * actually do.
 *
 * The SOP file states an authority. That is a CLAIM. This loader turns it into
 * a GRANT only when a signed manifest entry matches the SOP's id, version,
 * digest and authority under the one trusted key. Everything else loads at
 * `observe` with a recorded reason.
 *
 * The downgrade is unconditional and there is no repair path. The loader has
 * access to files and one public key -- not to configuration history, not to a
 * previous decision, not to an operator's intent. It cannot raise an
 * authority, and nothing at runtime can undo a downgrade.
 * @module dsh-plugin-ops-agent/authority-manifest-loader
 */
import { createPublicKey, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  resolveAuthority,
  type SopAuthority,
  type SopDefinition,
  type SignedAuthorityManifest,
} from "@helium/core";

export interface ResolvedSopAuthority {
  authority: SopAuthority;
  /** Present exactly when the file's claim was not granted. */
  authorityDowngradeReason?: string;
}

export interface AuthoritySource {
  manifest?: SignedAuthorityManifest;
  trustedKey?: KeyObject;
  /** Why no manifest or key is available, when that is the case. */
  unavailableReason?: string;
}

/**
 * Read the manifest and trusted key from disk.
 *
 * A missing or unreadable file is NOT an error here: it is the fail-closed
 * state, and it produces `observe` for every SOP that wanted more.
 */
export function loadAuthoritySource(paths: {
  authorityManifestPath: string;
  trustedKeyPath: string;
}): AuthoritySource {
  let manifest: SignedAuthorityManifest;
  try {
    manifest = JSON.parse(readFileSync(paths.authorityManifestPath, "utf8"));
  } catch {
    return { unavailableReason: "manifest-missing" };
  }
  let trustedKey: KeyObject;
  try {
    trustedKey = createPublicKey(readFileSync(paths.trustedKeyPath, "utf8"));
  } catch {
    return { unavailableReason: "trusted-key-unavailable" };
  }
  return { manifest, trustedKey };
}

/**
 * Resolve one SOP's effective authority.
 *
 * An SOP that only claims `observe` needs no grant -- observing is what a
 * loaded SOP does by default, and requiring a signature to do nothing would
 * make the manifest a availability dependency for reading.
 */
export function resolveSopAuthority(
  sop: SopDefinition,
  source: AuthoritySource,
): ResolvedSopAuthority {
  if (sop.authority === "observe" || sop.authority === "forbidden") {
    return { authority: sop.authority };
  }
  if (source.manifest === undefined || source.trustedKey === undefined) {
    return {
      authority: "observe",
      authorityDowngradeReason: source.unavailableReason ?? "manifest-missing",
    };
  }
  const resolution = resolveAuthority(
    {
      id: sop.id,
      version: sop.version,
      digest: sop.digest,
      authority: sop.authority,
    },
    source.manifest,
    source.trustedKey,
  );
  if ("manifestEntry" in resolution) {
    return { authority: resolution.authority };
  }
  return {
    authority: "observe",
    authorityDowngradeReason: resolution.reason,
  };
}
