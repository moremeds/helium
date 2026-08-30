import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CheckRegistry,
  ComponentSpecSchema,
  SopDefinitionSchema,
  canonicalJson,
  certifySop,
  type SopDefinition,
} from "@helium/core";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { loadAuthoritySource, resolveSopAuthority } from "../src/authority-manifest-loader.js";
import { RegisteredScriptSchema, ScriptRegistry } from "../src/script-registry.js";

const root = process.cwd();
const inventoryPath = join(root, "docs/ops/script-inventory.md");
const executorDir = join(root, "ops/executors");
const sopDir = join(root, "ops/sops");
const checkDir = join(root, "ops/checks");
const componentDir = join(root, "ops/components");
const reconcileWrapper = join(
  root,
  "scripts/ops/actions/trading-stack-reconcile.mjs",
);

const executorIds = [
  "trading-stack-reconcile",
  "colima-restart",
  "livewire-targeted-repair",
] as const;
const sopIds = [
  "colima-reconnect",
  "colima-bounded-restart",
  "livewire-targeted-parquet-repair",
] as const;

function yaml(path: string): unknown {
  return parse(readFileSync(path, "utf8"), { strict: true, uniqueKeys: true });
}

function documents(dir: string): unknown[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".yaml"))
    .sort()
    .map((name) => yaml(join(dir, name)));
}

function section(markdown: string, id: string): string {
  const marker = `## ${id}\n`;
  const start = markdown.indexOf(marker);
  if (start < 0) throw new Error(`inventory section missing: ${id}`);
  const bodyStart = start + marker.length;
  const next = markdown.indexOf("\n## ", bodyStart);
  return markdown.slice(bodyStart, next < 0 ? undefined : next);
}

function computedSopDigest(sop: SopDefinition): string {
  const { digest: _digest, ...unsigned } = sop;
  return `sha256:${createHash("sha256").update(canonicalJson(unsigned)).digest("hex")}`;
}

describe("initial operations script inventory", () => {
  it("records every required certification field and explicit blocker", () => {
    const inventory = readFileSync(inventoryPath, "utf8");
    for (const id of [...executorIds, ...sopIds]) {
      const entry = section(inventory, id);
      for (const field of [
        "Repository owner",
        "Deployment owner",
        "Exact path",
        "Release or hash identity",
        "Argv schema",
        "Working directory",
        "Environment profile",
        "Preflight",
        "Postconditions",
        "Timeout",
        "Attempt limit",
        "Cooldown",
        "Blast radius",
        "Rollback or compensation",
        "Drill state",
        "Mutation owner",
        "Certification state",
      ]) {
        expect(entry, `${id}: ${field}`).toContain(`- ${field}:`);
      }
      expect(entry).toMatch(/Certification state: (blocked|fixture-only)/);
    }
    expect(inventory).toContain("IB Gateway restart: forbidden");
    expect(inventory).toContain("AC#1");
  });

  it("keeps every undeployed executor registration fail-closed", () => {
    const raw = executorIds.map((id) => yaml(join(executorDir, `${id}.yaml`)));
    const scripts = raw.map((value) => RegisteredScriptSchema.parse(value));
    const registry = ScriptRegistry.load(raw);
    expect(scripts.map((script) => script.executorId).sort()).toEqual([...executorIds].sort());
    for (const script of scripts) {
      expect(script.path).toMatch(/^\/__HELIUM_UNCERTIFIED__\//);
      expect(registry.verifyIdentity(script)).toMatchObject({
        ok: false,
        reason: "script-missing",
      });
    }
  });

  it("records the wrapper boundary without claiming deployment or mutation ownership", () => {
    const entry = section(readFileSync(inventoryPath, "utf8"), "trading-stack-reconcile");
    expect(entry).toContain(
      "- Wrapper source: `scripts/ops/actions/trading-stack-reconcile.mjs`",
    );
    expect(entry).toContain(
      "- Wrapper installer: `scripts/ops/actions/install-action-wrapper.mjs`",
    );
    expect(entry).toContain(
      "- Planned immutable path: `$OPS_ROOT/actions/sha256-15f49270f6a5f0ad118a91af92dfe96327109fadbfdad2c8022a1b0bc568a074/trading-stack-reconcile.mjs`",
    );
    expect(entry).toContain(
      "- Underlying target identity: `/Users/moremeds/trading-stack/scripts/reconcile.sh`",
    );
    expect(entry).toContain("- Deployment state: not deployed");
    expect(entry).toContain(
      `- Wrapper source identity: SHA-256 \`${createHash("sha256")
        .update(readFileSync(reconcileWrapper))
        .digest("hex")}\``,
    );
    expect(entry).toContain("- Mutation owner: `colima=external`");
    expect(entry).toContain("- Certification state: blocked");
  });

  it("keeps every mutating SOP ineffective while ownership and live identity are unresolved", () => {
    const checks = documents(checkDir);
    const probeIds = checks.map((raw) =>
      (raw as { probe: { probeId: string } }).probe.probeId,
    );
    const registry = CheckRegistry.load(checks, probeIds);
    const components = documents(componentDir).map((raw) => ComponentSpecSchema.parse(raw));
    const byComponent = new Map(components.map((component) => [component.id, component]));
    const authority = loadAuthoritySource({
      authorityManifestPath: join(root, "ops/authority-manifest.json"),
      trustedKeyPath: join(root, "ops/authority-manifest.pub.pem"),
    });

    for (const id of sopIds) {
      const sop = SopDefinitionSchema.parse(yaml(join(sopDir, `${id}.yaml`)));
      expect(sop.digest).toBe(computedSopDigest(sop));
      const component = byComponent.get(sop.componentId);
      expect(component?.mutationOwner.owner).not.toBe("opsd");
      expect(certifySop(sop, registry, component)).toEqual({
        certified: false,
        reasons: [`mutation-owner-not-opsd:${component?.mutationOwner.owner}`],
      });
      expect(existsSync(sop.action.executable.path)).toBe(false);
      expect(resolveSopAuthority(sop, authority)).toMatchObject({
        authority: "observe",
      });
    }
  });

  it("does not register an IB Gateway restart or any free-form command", () => {
    const text = [
      ...executorIds.map((id) => readFileSync(join(executorDir, `${id}.yaml`), "utf8")),
      ...sopIds.map((id) => readFileSync(join(sopDir, `${id}.yaml`), "utf8")),
    ].join("\n");
    expect(text).not.toMatch(/ib.?gateway/i);
    expect(text).not.toMatch(/^\s*(command|shell):/m);
  });
});
