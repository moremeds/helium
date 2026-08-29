import { generateKeyPairSync, sign } from "node:crypto";
import {
  manifestSigningPayload,
  type AuthorityManifestEntry,
  type CheckDefinition,
  type SopDefinition,
} from "@helium/core";
import { describe, expect, it } from "vitest";
import { ComponentRegistry, type OpsBundle } from "./component-registry.js";
import type { AuthoritySource } from "./authority-manifest-loader.js";

const { publicKey: trustedKey, privateKey } = generateKeyPairSync("ed25519");
const now = () => new Date("2026-08-25T04:00:00.000Z");
const digest = `sha256:${"a".repeat(64)}`;
const probes = ["fixture.http.v1", "fixture.liveness.v1"];

const component = (id: string, kind = "service") => ({
  version: 1,
  id,
  kind,
  mutationOwner: {
    owner: "none",
    competingLabels: [],
    changedAt: "2026-08-25T00:00:00.000Z",
    changeRef: "fixture",
  },
});

const check = (id: string, kind: "business" | "liveness"): CheckDefinition => ({
  id,
  kind,
  probe: { probeId: "fixture.http.v1", args: {} },
  expect: { dimension: "readiness", operator: "eq", value: true },
  onUnavailable: "unknown",
  timeoutMs: 30_000,
  owner: "operator",
});

const sop = (
  id: string,
  authority: SopDefinition["authority"],
  overrides: Partial<SopDefinition> = {},
) => ({
  version: 1,
  id,
  digest,
  componentId: "fixture-service",
  matches: { dimension: "readiness", failureClass: "failed" },
  authority,
  mutating: true,
  priority: 10,
  action: {
    executorId: "fixture-script",
    executable: {
      path: "/opt/ops/fixture.sh",
      identity: { kind: "sha256", value: "b".repeat(64) },
    },
    argvSchemaId: "fixture-argv-v1",
    cwdId: "ops-workdir",
    environmentProfileId: "ops-minimal",
    timeoutMs: 60_000,
  },
  preconditions: [],
  postconditions: ["fixture-business"],
  graceMs: 30_000,
  maxAttempts: 2,
  cooldownMs: 600_000,
  ...overrides,
});

const signed = (entries: AuthorityManifestEntry[]): AuthoritySource => ({
  manifest: {
    entries,
    signature: sign(null, manifestSigningPayload(entries), privateKey).toString(
      "base64",
    ),
  },
  trustedKey,
});

const bundle = (overrides: Partial<OpsBundle> = {}): OpsBundle => ({
  tenantId: "fixture",
  components: [component("fixture-service")],
  checks: [check("fixture-business", "business")],
  sops: [],
  ...overrides,
});

const registry = (authority: AuthoritySource = signed([])) =>
  new ComponentRegistry({ authority, registeredProbeIds: probes, now });

describe("installation", () => {
  it("installs a bundle and disposes exactly what it added", () => {
    const r = registry();
    const dispose = r.install(bundle());
    expect(r.component("fixture-service")).toBeDefined();
    dispose();
    expect(r.component("fixture-service")).toBeUndefined();
  });

  // A component kind this package has never heard of loads without a
  // TypeScript edit. That is acceptance criterion 14, tested rather than
  // asserted.
  it("loads a component kind it has never heard of", () => {
    const r = registry();
    r.install(
      bundle({
        tenantId: "future",
        components: [component("future-service", "future-component-kind")],
      }),
    );
    expect(r.component("future-service")?.kind).toBe("future-component-kind");
  });

  it("refuses a duplicate component or SOP identity", () => {
    const r = registry();
    r.install(bundle());
    expect(() => r.install(bundle({ tenantId: "again" }))).toThrow(/duplicate component/);
  });

  it("refuses a bundle whose edges make a cycle", () => {
    const r = registry();
    expect(() =>
      r.install(
        bundle({
          components: [component("a"), component("b")],
          edges: [
            { from: "a", to: "b" },
            { from: "b", to: "a" },
          ],
        }),
      ),
    ).toThrow(/cycle/i);
  });

  it("refuses a check naming a probe nothing registered", () => {
    const r = registry();
    expect(() =>
      r.install(
        bundle({
          checks: [{ ...check("ghost", "business"), probe: { probeId: "nope.v1", args: {} } }],
        }),
      ),
    ).toThrow(/nope\.v1/);
  });

  // A loader that half-applied a bundle would leave the daemon describing a
  // topology that never existed.
  it("fails only the bad tenant, leaving installed healthy components alone", () => {
    const r = registry();
    r.install(bundle());
    expect(() =>
      r.install(
        bundle({
          tenantId: "broken",
          components: [component("broken-service")],
          checks: [{ ...check("bad", "business"), probe: { probeId: "nope.v1", args: {} } }],
        }),
      ),
    ).toThrow();
    expect(r.component("fixture-service")).toBeDefined();
    expect(r.component("broken-service")).toBeUndefined();
  });

  it("refuses a bundle that would exceed its limits, installing none of it", () => {
    const r = new ComponentRegistry({
      authority: signed([]),
      registeredProbeIds: probes,
      now,
      limits: { maxComponents: 1 },
    });
    r.install(bundle());
    expect(() =>
      r.install(bundle({ tenantId: "second", components: [component("second")] })),
    ).toThrow(/component limit/);
    expect(r.component("second")).toBeUndefined();
  });
});

describe("authority is granted by the manifest, never by the file", () => {
  const autoSop = sop("fixture-auto", "auto");
  const withAutoSop = bundle({ sops: [autoSop] });

  it.each([
    [
      "the manifest does not list it",
      signed([]),
      "manifest-entry-missing",
    ],
    [
      "the digest does not match",
      signed([
        { sopId: "fixture-auto", version: 1, digest: `sha256:${"c".repeat(64)}`, authority: "auto" },
      ]),
      "manifest-digest-mismatch",
    ],
    [
      "the version does not match",
      signed([{ sopId: "fixture-auto", version: 9, digest, authority: "auto" }]),
      "manifest-version-mismatch",
    ],
    [
      "the entry grants less than the file claims",
      signed([{ sopId: "fixture-auto", version: 1, digest, authority: "approve" }]),
      "manifest-authority-escalation",
    ],
    [
      "no manifest file is available at all",
      { unavailableReason: "manifest-missing" } as AuthoritySource,
      "manifest-missing",
    ],
  ])("loads at observe when %s", (_label, authority, reason) => {
    const r = registry(authority);
    r.install(withAutoSop);
    expect(r.sop("fixture-auto")?.authority).toBe("observe");
    expect(r.sop("fixture-auto")?.authorityDowngradeReason).toBe(reason);
    expect(r.eligibleForMutation("fixture-auto")).toBe(false);
  });

  it("loads at observe when the signature does not verify", () => {
    const source = signed([{ sopId: "fixture-auto", version: 1, digest, authority: "auto" }]);
    source.manifest!.entries.push({
      sopId: "sneaked-in",
      version: 1,
      digest,
      authority: "auto",
    });
    const r = registry(source);
    r.install(withAutoSop);
    expect(r.sop("fixture-auto")).toMatchObject({
      authority: "observe",
      authorityDowngradeReason: "manifest-signature-invalid",
    });
  });

  it("grants the claimed authority for a fully matching signed entry", () => {
    const r = registry(
      signed([{ sopId: "fixture-auto", version: 1, digest, authority: "auto" }]),
    );
    r.install(withAutoSop);
    expect(r.sop("fixture-auto")?.authority).toBe("auto");
    expect(r.sop("fixture-auto")?.authorityDowngradeReason).toBeUndefined();
    expect(r.eligibleForMutation("fixture-auto")).toBe(true);
  });

  // The loader has files and one public key. It has no configuration history,
  // no previous decision, and no way to infer intent.
  it("never raises an authority above the file's own claim", () => {
    const observeSop = sop("fixture-observe", "observe");
    const r = registry(
      signed([{ sopId: "fixture-observe", version: 1, digest, authority: "auto" }]),
    );
    r.install(bundle({ sops: [observeSop] }));
    expect(r.sop("fixture-observe")?.authority).toBe("observe");
    expect(r.eligibleForMutation("fixture-observe")).toBe(false);
  });

  it("emits a controller observation naming the SOP and the reason", () => {
    const r = registry();
    r.install(withAutoSop);
    const [observation] = r.observations();
    expect(observation).toMatchObject({
      componentId: "fixture-service",
      dimension: "controller",
      state: "degraded",
    });
    expect(observation.value).toMatchObject({
      sopId: "fixture-auto",
      claimedAuthority: "auto",
      grantedAuthority: "observe",
      reason: "manifest-entry-missing",
    });
  });

  it("offers no runtime path that repairs a downgrade", () => {
    const r = registry();
    r.install(withAutoSop);
    for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(r))) {
      expect(name.toLowerCase()).not.toMatch(/grant|raise|promote|override/);
    }
    expect(r.sop("fixture-auto")?.authority).toBe("observe");
  });
});

describe("certification travels with loading", () => {
  it("marks a mutating SOP with only a liveness postcondition uncertified", () => {
    const r = registry(
      signed([{ sopId: "fixture-auto", version: 1, digest, authority: "auto" }]),
    );
    r.install(
      bundle({
        checks: [check("fixture-liveness", "liveness")],
        sops: [sop("fixture-auto", "auto", { postconditions: ["fixture-liveness"] })],
      }),
    );
    const loaded = r.sop("fixture-auto");
    expect(loaded?.certified).toBe(false);
    expect(loaded?.certificationReasons.join(" ")).toMatch(/business/);
    expect(r.eligibleForMutation("fixture-auto")).toBe(false);
  });
});
