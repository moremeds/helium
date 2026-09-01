import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTeamYaml } from "../src/team/manifest.js";

const valid = `
manifestVersion: team-v1
name: test-team
roles:
  researcher:
    responsibility: evidence
    requires: [source-research]
    permissions:
      externalResearch: true
      mutations: forbidden
      artifactRead: [source-artifacts, dependency-artifacts]
  renderer:
    responsibility: rendering
    requires: [render-adjudicated-claims]
    permissions:
      externalResearch: false
      mutations: forbidden
      artifactRead: [accepted-claim-ledger]
tasks:
  - id: research
    role: researcher
    dependsOn: []
    requires: [source-research]
    inputs: [source-artifacts]
    outputSchema: ClaimSet.v1
  - id: render
    role: renderer
    dependsOn: [research]
    requires: [render-adjudicated-claims]
    inputs: [accepted-claim-ledger]
    outputSchema: ShadowReport.v1
crossReference:
  compareClaims: true
  materialContradictions: fresh-evidence-work-order
  requireIndependentEvidence: true
budgets:
  maxAttempts: 20
  maxTokens: 100000
acceptance:
  allowPartialClaims: true
  terminalTasks: [render]
`;

describe("parseTeamYaml", () => {
  it("parses roles, capability contracts, a DAG, budgets, and acceptance", () => {
    const manifest = parseTeamYaml(valid);
    expect(manifest.roles.researcher?.requires).toEqual(["source-research"]);
    expect(manifest.tasks.map((task) => task.id)).toEqual(["research", "render"]);
    expect(manifest.crossReference.materialContradictions).toBe(
      "fresh-evidence-work-order",
    );
  });

  it("rejects provider and model keys at nested depths", () => {
    expect(() =>
      parseTeamYaml(valid.replace("requires: [source-research]", "model: forbidden\n    requires: [source-research]")),
    ).toThrow(/unrecognized key.*model/is);
    expect(() =>
      parseTeamYaml(valid.replace("outputSchema: ClaimSet.v1", "outputSchema: ClaimSet.v1\n    provider: forbidden")),
    ).toThrow(/unrecognized key.*provider/is);
  });

  it("rejects cycles, unknown roles, and missing capability requirements", () => {
    expect(() =>
      parseTeamYaml(valid.replace("dependsOn: []", "dependsOn: [render]")),
    ).toThrow(/cycle/i);
    expect(() =>
      parseTeamYaml(valid.replace("role: researcher", "role: missing")),
    ).toThrow(/unknown role/i);
    expect(() =>
      parseTeamYaml(valid.replace("requires: [source-research]", "requires: []")),
    ).toThrow(/requires/i);
  });

  it("requires rendering roles to read only the accepted claim ledger", () => {
    expect(() =>
      parseTeamYaml(
        valid.replace(
          "artifactRead: [accepted-claim-ledger]",
          "artifactRead: [accepted-claim-ledger, source-artifacts]",
        ),
      ),
    ).toThrow(/renderer.*accepted claim ledger/i);
    expect(() =>
      parseTeamYaml(valid.replace("externalResearch: false", "externalResearch: true")),
    ).toThrow(/renderer.*external research/i);
  });

  it("loads the committed provider-neutral macro DAG", () => {
    const path = resolve(import.meta.dirname, "../../../evals/fixtures/macro-team/team.yaml");
    const text = readFileSync(path, "utf8");
    const manifest = parseTeamYaml(text);
    expect(manifest.tasks.map((task) => [task.id, task.dependsOn])).toEqual([
      ["inflation-evidence", []],
      ["policy-evidence", []],
      ["rates-path", ["inflation-evidence", "policy-evidence"]],
      ["usd-transmission", ["rates-path"]],
      ["gold-impact", ["usd-transmission"]],
      ["verifier", ["usd-transmission", "gold-impact"]],
      ["lead-synthesis", ["verifier"]],
      ["renderer", ["lead-synthesis"]],
    ]);
    expect(text).not.toMatch(/^\s*(provider|model)\s*:/m);
    expect(manifest.roles.renderer?.permissions).toEqual({
      externalResearch: false,
      mutations: "forbidden",
      artifactRead: ["accepted-claim-ledger"],
      tools: [],
    });
  });
});
