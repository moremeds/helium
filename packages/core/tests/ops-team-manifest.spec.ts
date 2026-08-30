import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTeamYaml } from "../src/team/manifest.js";

const manifestPath = resolve(import.meta.dirname, "../../../teams/ops.yaml");

describe("ops team manifest", () => {
  it("loads the provider-neutral four-role Ops DAG", () => {
    const text = readFileSync(manifestPath, "utf8");
    const manifest = parseTeamYaml(text);

    expect(Object.keys(manifest.roles)).toEqual([
      "diagnostician",
      "independent-verifier",
      "incident-lead",
      "reporter",
    ]);
    expect(manifest.tasks.map((task) => [task.id, task.dependsOn])).toEqual([
      ["diagnosis", []],
      ["independent-verification", []],
      ["incident-decision", ["diagnosis", "independent-verification"]],
      ["incident-report", ["incident-decision"]],
    ]);
    expect(text).not.toMatch(/^\s*(provider|model|effort)\s*:/m);
  });

  it("gives every role read-only evidence access and reserves SOP selection for the lead", () => {
    const manifest = parseTeamYaml(readFileSync(manifestPath, "utf8"));
    for (const role of Object.values(manifest.roles)) {
      expect(role.permissions.artifactRead.length).toBeGreaterThan(0);
      expect(role.permissions.externalResearch).toBe(false);
    }
    expect(manifest.roles.diagnostician?.permissions.mutations).toBe("forbidden");
    expect(manifest.roles["independent-verifier"]?.permissions.mutations).toBe("forbidden");
    expect(manifest.roles.reporter?.permissions.mutations).toBe("forbidden");
    expect(manifest.roles["incident-lead"]?.permissions.mutations).toBe("permitted");
  });

  it.each(["provider", "model", "effort"])("rejects a nested %s routing field", (field) => {
    const text = readFileSync(manifestPath, "utf8").replace(
      "requires: [ops-diagnosis]",
      `${field}: forbidden\n    requires: [ops-diagnosis]`,
    );
    expect(() => parseTeamYaml(text)).toThrow(/unrecognized key/i);
  });
});
