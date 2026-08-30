import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { OpsBundleLoader } from "./bundle-loader.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const now = () => new Date("2026-08-29T12:00:00.000Z");
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

const config = (overrides: Record<string, unknown> = {}) => ({
  componentsDir: "ops/components",
  dependenciesDir: "ops/dependencies",
  sopsDir: "ops/sops",
  checksDir: "ops/checks",
  authorityManifestPath: "ops/authority-manifest.json",
  trustedKeyPath: "ops/authority-manifest.pub.pem",
  ...overrides,
});

function tempTree(): string {
  const root = mkdtempSync(join(tmpdir(), "helium-ops-loader-"));
  roots.push(root);
  for (const dir of ["components", "dependencies", "sops", "checks"]) {
    mkdirSync(join(root, "ops", dir), { recursive: true });
  }
  return root;
}

function componentYaml(id: string): string {
  return [
    "version: 1",
    `id: ${id}`,
    "kind: future-component-kind",
    "mutationOwner:",
    "  owner: none",
    "  competingLabels: []",
    '  changedAt: "2026-08-29T00:00:00.000Z"',
    '  changeRef: "fixture"',
    "",
  ].join("\n");
}

describe("OpsBundleLoader", () => {
  it("loads the committed component and SOP YAML through the authority-aware registry", () => {
    const loader = new OpsBundleLoader({
      baseDir: repoRoot,
      config: config(),
      registeredProbeIds: [
        "fixture.readiness.v1",
        "colima.vm-status.v1",
        "host.volume.data-lake.v1",
        "colima.transport.v1",
        "colima.container-inventory.v1",
        "livewire.input-source.v1",
        "livewire.parquet-integrity.v1",
        "livewire.target-freshness.v1",
        "livewire.coverage.v1",
      ],
      now,
    });

    const installed = loader.installTenant("phase-c", repoRoot);
    expect(installed.health).toEqual({ tenantId: "phase-c", state: "loaded" });
    expect(loader.registry.component("fixture-service")).toBeDefined();
    expect(loader.registry.component("livewire")).toBeDefined();
    expect(loader.registry.sop("fixture-observe")).toMatchObject({
      authority: "observe",
      certified: true,
    });
    expect(loader.registry.sop("colima-reconnect")).toMatchObject({
      authority: "observe",
      authorityDowngradeReason: "manifest-entry-missing",
      certified: false,
      certificationReasons: ["mutation-owner-not-opsd:external"],
    });
    expect(loader.registry.graph().dependenciesOf("apex")).toEqual([
      "livewire",
      "postgres",
    ]);
  });

  it("loads a future component written only as YAML and disposes it effect-scoped", () => {
    const root = tempTree();
    writeFileSync(join(root, "ops/components/future.yaml"), componentYaml("future-service"));
    const loader = new OpsBundleLoader({
      baseDir: root,
      config: config(),
      registeredProbeIds: [],
      now,
    });

    const installed = loader.installTenant("future", root);
    expect(installed.health.state).toBe("loaded");
    expect(loader.registry.component("future-service")?.kind).toBe("future-component-kind");
    installed.dispose?.();
    expect(loader.registry.component("future-service")).toBeUndefined();
  });

  it("enforces the aggregate file-count and per-file byte bounds before install", () => {
    const root = tempTree();
    writeFileSync(join(root, "ops/components/one.yaml"), componentYaml("one"));
    writeFileSync(join(root, "ops/components/two.yaml"), componentYaml("two"));

    const countBound = new OpsBundleLoader({
      baseDir: root,
      config: config({ maxFiles: 1 }),
      registeredProbeIds: [],
      now,
    });
    expect(countBound.installTenant("count", root).health).toMatchObject({
      state: "invalid",
      detail: expect.stringMatching(/file limit/),
    });
    expect(countBound.registry.components()).toEqual([]);

    const byteBound = new OpsBundleLoader({
      baseDir: root,
      config: config({ maxFileBytes: 20 }),
      registeredProbeIds: [],
      now,
    });
    expect(byteBound.installTenant("bytes", root).health).toMatchObject({
      state: "invalid",
      detail: expect.stringMatching(/byte limit/),
    });
    expect(byteBound.registry.components()).toEqual([]);
  });

  it("selects files from each tenant base and leaves a bad tenant isolated", () => {
    const root = tempTree();
    const healthyRoot = join(root, "tenants", "healthy");
    const brokenRoot = join(root, "tenants", "broken");
    for (const tenantRoot of [healthyRoot, brokenRoot]) {
      for (const dir of ["components", "dependencies", "sops", "checks"]) {
        mkdirSync(join(tenantRoot, "ops", dir), { recursive: true });
      }
    }
    writeFileSync(
      join(healthyRoot, "ops/components/healthy.yaml"),
      componentYaml("healthy"),
    );
    writeFileSync(
      join(brokenRoot, "ops/components/broken.yaml"),
      "version: [not closed",
    );
    const loader = new OpsBundleLoader({
      baseDir: root,
      config: config(),
      registeredProbeIds: [],
      now,
    });
    expect(loader.installTenant("healthy", healthyRoot).health.state).toBe("loaded");

    const bad = loader.installTenant("broken", brokenRoot);
    expect(bad.health).toMatchObject({ state: "invalid" });
    expect(loader.registry.component("healthy")).toBeDefined();
    expect(loader.registry.component("broken")).toBeUndefined();
  });
});
