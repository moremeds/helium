/** Hardware-bound signing-host policy. Production callers cannot supply an env override. */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const policyPath = fileURLToPath(
  new URL("../../ops/signing-host-policy.json", import.meta.url),
);

export function hardwareIdentity() {
  if (process.platform === "darwin") {
    const output = execFileSync("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
      encoding: "utf8",
      timeout: 2_000,
    });
    const match = output.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
    if (match?.[1] === undefined) throw new Error("cannot read signing host hardware identity");
    return match[1];
  }
  if (process.platform === "linux") {
    return readFileSync("/etc/machine-id", "utf8").trim();
  }
  throw new Error(`unsupported signing host platform: ${process.platform}`);
}

export const hardwareIdentityHash = (identity) =>
  createHash("sha256").update(identity).digest("hex");

export function assertTrustedSigningHost(testOptions = undefined) {
  const policy = testOptions?.policy ?? JSON.parse(readFileSync(policyPath, "utf8"));
  if (policy?.version !== 1 ||
      !Array.isArray(policy.allowedOperatorHostHashes) ||
      !Array.isArray(policy.forbiddenMiniHostHashes) ||
      policy.allowedOperatorHostHashes.length === 0 ||
      policy.forbiddenMiniHostHashes.length === 0) {
    throw new Error(
      "signing host policy is not commissioned; register both operator and mini hardware hashes",
    );
  }
  const identity = testOptions?.hardwareIdentity ?? hardwareIdentity();
  const hash = hardwareIdentityHash(identity);
  if (policy.forbiddenMiniHostHashes.includes(hash)) {
    throw new Error("signer refuses to run on the registered mini");
  }
  if (!policy.allowedOperatorHostHashes.includes(hash)) {
    throw new Error("signer refuses an unregistered operator workstation");
  }
  return hash;
}
