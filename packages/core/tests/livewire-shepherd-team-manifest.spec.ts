import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTeamYaml, type TeamManifest } from "../src/index.js";

const load = (variant: string): TeamManifest => parseTeamYaml(readFileSync(
  resolve(import.meta.dirname, `../../../plugins/livewire-shepherd/team-${variant}.yaml`),
  "utf8",
));

const expectedTools: Record<string, string[]> = {
  "incident-lead": [],
  "ib-investigator": ["livewire.evidence.read", "livewire.ib.observe"],
  "massive-investigator": ["livewire.evidence.read", "livewire.massive.read"],
  "corporate-action-universe-researcher": ["livewire.evidence.read", "anysearch.search", "anysearch.extract", "opencli.read"],
  "pit-adjudicator": ["livewire.evidence.read"],
  "repair-planner": ["livewire.evidence.read", "livewire.repair.eligible"],
  "independent-verifier": ["livewire.evidence.read", "livewire.probe.request"],
  reporter: [],
};

describe("Livewire Shepherd team manifests", () => {
  it("uses the minimum approved roster for each incident class", () => {
    expect(Object.keys(load("repair").roles).sort()).toEqual([
      "incident-lead", "independent-verifier", "repair-planner", "reporter",
    ]);
    expect(Object.keys(load("source-conflict").roles).sort()).toEqual([
      "ib-investigator", "incident-lead", "independent-verifier", "massive-investigator", "repair-planner", "reporter",
    ]);
    expect(Object.keys(load("pit").roles).sort()).toEqual([
      "corporate-action-universe-researcher", "ib-investigator", "incident-lead", "independent-verifier",
      "massive-investigator", "pit-adjudicator", "repair-planner", "reporter",
    ]);
  });

  it("grants only the exact read/probe allowlist and no mutation permission", () => {
    for (const variant of ["repair", "source-conflict", "pit"]) {
      const manifest = load(variant);
      for (const [role, spec] of Object.entries(manifest.roles)) {
        expect(spec.permissions.mutations, `${variant}:${role}`).toBe("forbidden");
        expect(spec.permissions.tools, `${variant}:${role}`).toEqual(expectedTools[role]);
      }
      expect(JSON.stringify(manifest)).not.toMatch(/provider|model|effort/i);
    }
  });

  it("routes all claims through independent verification before planning, lead, or reporting", () => {
    for (const variant of ["repair", "source-conflict", "pit"]) {
      const manifest = load(variant);
      const verifier = manifest.tasks.find((task) => task.id === "independent-verification")!;
      expect(verifier.outputSchema).toBe("EvidenceDecisionSet.v1");
      for (const id of ["repair-proposal", "incident-decision"]) {
        expect(manifest.tasks.find((task) => task.id === id)?.dependsOn).toContain(verifier.id);
      }
      expect(manifest.tasks.find((task) => task.id === "incident-report")?.dependsOn).toContain("incident-decision");
      expect(manifest.tasks.find((task) => task.id === "repair-proposal")?.outputSchema).toBe("ShepherdRepairProposal.v1");
    }
    expect(load("pit").tasks.filter((task) => [
      "ib-investigation", "massive-investigation", "corporate-action-universe-research", "pit-adjudication",
    ].includes(task.id)).every((task) => task.outputSchema === "ShepherdClaimSet.v1")).toBe(true);
  });
});
