import { describe, expect, it } from "vitest";
import {
  OpsdRuntimeConfigSchema,
  authorizeAutomaticArgv,
  automaticAuthorityInputDigest,
} from "../../plugins/ops-agent/src/bin/opsd.js";

const cap = {
  kind: "exact-argv" as const,
  sopId: "livewire-shepherd-targeted-repair",
  componentId: "livewire",
  executorId: "livewire-repair-transaction",
  argv: ["--manifest", "/var/db/helium/livewire-shepherd/ready/sha256:abc.json"],
  postconditionIds: ["livewire-repair-integrity", "livewire-repair-coverage"],
};

const config = {
  version: 1,
  mode: "auto",
  releaseDir: "/opt/helium/current",
  promotionBundleDir: "/opt/helium/promotions/livewire-repair",
  automaticAuthority: cap,
  componentsDir: "components",
  dependenciesDir: "dependencies",
  checksDir: "checks",
  sopsDir: "sops",
  executorsDir: "executors",
  authorityManifestPath: "/opt/helium/promotions/livewire-repair/authority.json",
  trustedKeyPath: "/opt/helium/current/authority.pub.pem",
  stateDir: "/var/db/helium/opsd",
  socketPath: "/var/run/helium-opsd.sock",
  intervalMs: 60_000,
  maxFiles: 500,
  maxComponents: 200,
  maxSops: 200,
  maxChecks: 500,
  maxFileBytes: 1_000_000,
};

describe("Livewire Shepherd automatic authority cap", () => {
  it("makes auto representable only with one explicit exact capability", () => {
    expect(OpsdRuntimeConfigSchema.parse(config).automaticAuthority).toEqual(cap);
    const { automaticAuthority: _drop, ...withoutCap } = config;
    expect(() => OpsdRuntimeConfigSchema.parse(withoutCap)).toThrow(/authority cap/);
    expect(() => OpsdRuntimeConfigSchema.parse({ ...config, mode: "approve" })).toThrow(
      /authority cap/,
    );
  });

  it("changes the signed promotion input for every authority-widening edit", () => {
    const input = {
      cap,
      component: { id: "livewire", mutationOwner: { owner: "opsd", competingLabels: [] } },
      sop: { id: cap.sopId, componentId: cap.componentId, postconditions: cap.postconditionIds },
      checks: cap.postconditionIds.map((id) => ({ id, kind: "business" })),
      executor: { executorId: cap.executorId, identity: { kind: "sha256", value: "a".repeat(64) } },
    };
    const anchor = automaticAuthorityInputDigest(input);
    for (const widened of [
      { ...input, cap: { ...cap, sopId: "second-sop" } },
      { ...input, component: { id: "livewire", mutationOwner: { owner: "external" } } },
      { ...input, executor: { ...input.executor, executorId: "arbitrary-executor" } },
      { ...input, cap: { ...cap, argv: [...cap.argv, "--wider"] } },
      { ...input, checks: [{ id: cap.postconditionIds[0], kind: "liveness" }] },
    ]) {
      expect(automaticAuthorityInputDigest(widened)).not.toBe(anchor);
    }
  });

  it("authorizes a dynamic manifest only inside one signed ready directory", () => {
    const { argv: _drop, ...manifestCap } = {
      ...cap,
      kind: "manifest-argv-v1" as const,
      manifestRoot: "/var/db/helium/livewire-shepherd/ready",
    };
    expect(() => authorizeAutomaticArgv(manifestCap, [
      "--manifest",
      `/var/db/helium/livewire-shepherd/ready/sha256:${"a".repeat(64)}.json`,
    ])).not.toThrow();
    expect(() => authorizeAutomaticArgv(manifestCap, [
      "--manifest",
      `/tmp/sha256:${"a".repeat(64)}.json`,
    ])).toThrow(/signed ready directory/);
    expect(() => authorizeAutomaticArgv(manifestCap, [
      "--manifest",
      "/var/db/helium/livewire-shepherd/ready/x.json",
      "--force",
    ])).toThrow(/requires only/);
  });
});
