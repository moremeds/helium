import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CheckDefinitionSchema,
  CheckRegistry,
  ComponentSpecSchema,
  SopDefinitionSchema,
  canonicalJson,
  certifySop,
} from "@helium/core";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { RegisteredScriptSchema, ScriptRegistry } from "../src/script-registry.js";

const root = process.cwd();
const promotion = join(root, "ops/promotions/trading-stack-reconcile");
const wrapper = join(root, "scripts/ops/actions/trading-stack-reconcile.mjs");

function yaml(path: string): unknown {
  return parse(readFileSync(path, "utf8"), { strict: true, uniqueKeys: true });
}

describe("approved trading-stack container reconcile promotion", () => {
  it("defines one bounded approve-only mutation without elevating the normal bundle", () => {
    const component = ComponentSpecSchema.parse(yaml(join(promotion, "components/colima.yaml")));
    const checks = [
      "colima-container-set",
      "colima-transport-ready",
      "data-lake-mounted",
    ].map((id) => CheckDefinitionSchema.parse(yaml(join(promotion, `checks/${id}.yaml`))));
    const executor = RegisteredScriptSchema.parse(
      yaml(join(promotion, "executors/trading-stack-reconcile.yaml")),
    );
    const sopPath = join(promotion, "sops/trading-stack-container-reconcile.yaml");
    const sop = SopDefinitionSchema.parse(yaml(sopPath));
    const normalComponent = ComponentSpecSchema.parse(yaml(join(root, "ops/components/colima.yaml")));
    const normalAuthority = JSON.parse(readFileSync(join(root, "ops/authority-manifest.json"), "utf8"));
    const inventory = readFileSync(join(root, "docs/ops/script-inventory.md"), "utf8");

    expect(component).toMatchObject({
      id: "colima",
      mutationOwner: {
        owner: "opsd",
        competingLabels: [
          "com.moremeds.colima-runtime-watchdog",
          "com.moremeds.colima-after-datalake",
        ],
      },
    });
    expect(component.mutationOwner.changeRef).toMatch(/pending.*signed-handoff/i);
    expect(normalComponent.mutationOwner.owner).toBe("external");
    expect(normalAuthority.entries).toEqual([]);
    expect(inventory).toContain(
      "Candidate promotion bundle: `ops/promotions/trading-stack-reconcile`",
    );
    expect(inventory).toContain("Candidate authority: `approve` only; never `auto`");
    expect(inventory).toContain("Candidate state: defined offline; not signed, installed, or active");

    expect(checks.map((check) => check.id).sort()).toEqual([
      "colima-container-set",
      "colima-transport-ready",
      "data-lake-mounted",
    ]);
    const checkRegistry = CheckRegistry.load(
      checks,
      JSON.parse(readFileSync(join(root, "ops/registered-probes.json"), "utf8")).probeIds,
    );

    const wrapperSha = createHash("sha256").update(readFileSync(wrapper)).digest("hex");
    expect(executor).toMatchObject({
      executorId: "trading-stack-reconcile",
      path: `/Users/moremeds/.helium/ops/actions/sha256-${wrapperSha}/trading-stack-reconcile.mjs`,
      identity: { kind: "sha256", value: wrapperSha },
      argvSchema: {
        id: "trading-stack-reconcile-argv-v1",
        params: [
          { flag: "--scope", valuePattern: "containers", required: true },
          { flag: "--pull", valuePattern: "false", required: true },
        ],
      },
      expectedOwnerUid: 501,
    });
    expect(ScriptRegistry.load([executor]).get(executor.executorId)).toEqual(executor);

    expect(sop).toMatchObject({
      id: "trading-stack-container-reconcile",
      componentId: "colima",
      matches: { dimension: "readiness", failureClass: "failed" },
      authority: "approve",
      mutating: true,
      action: {
        executorId: "trading-stack-reconcile",
        executable: { path: executor.path, identity: executor.identity },
        argvSchemaId: "trading-stack-reconcile-argv-v1",
        timeoutMs: 120_000,
      },
      preconditions: ["data-lake-mounted", "colima-transport-ready"],
      postconditions: ["colima-container-set"],
      maxAttempts: 1,
    });
    expect(sop.cooldownMs).toBeGreaterThanOrEqual(1_800_000);
    expect(sop.graceMs).toBeGreaterThan(0);
    const { digest: _digest, ...unsigned } = sop;
    expect(sop.digest).toBe(
      `sha256:${createHash("sha256").update(canonicalJson(unsigned)).digest("hex")}`,
    );
    expect(certifySop(sop, checkRegistry, component)).toEqual({ certified: true, reasons: [] });

    const commandSurface = JSON.stringify({ action: sop.action, executor }).toLowerCase();
    expect(commandSurface).not.toMatch(/ib.?gateway|\bprune\b|\bvolume\b/);
    expect(commandSurface).not.toMatch(/"(command|shell)"/);
  });
});
