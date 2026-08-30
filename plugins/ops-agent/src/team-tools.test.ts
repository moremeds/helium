import { describe, expect, it, vi } from "vitest";
import { createOpsTeamTools, type OpsTeamRole } from "./team-tools.js";

const roles: OpsTeamRole[] = [
  "diagnostician",
  "independent-verifier",
  "incident-lead",
  "reporter",
];

describe("Ops team tool boundary", () => {
  it("offers read-only evidence tools to every role and no shell", () => {
    for (const role of roles) {
      const tools = createOpsTeamTools({
        role,
        readEvidence: async () => ({ state: "degraded" }),
        requestFreshProbe: async () => "artifact://probe/fresh",
        eligibility: () => ({
          incidentId: "incident-1",
          snapshotId: "eligibility-1",
          sopIds: ["restart-service"],
        }),
        submitSelection: async () => {},
      });
      expect(tools.names()).toEqual(expect.arrayContaining([
        "ops.evidence.read",
        "ops.probe.request",
      ]));
      expect(tools.names()).not.toContain("shell");
      expect(tools.names()).not.toContain("ops.shell");
      expect(tools.names().includes("ops.sop.select")).toBe(role === "incident-lead");
    }
  });

  it("lets only the incident lead select from the exact deterministic eligible set", async () => {
    const submitSelection = vi.fn(async () => {});
    const common = {
      readEvidence: async () => ({ state: "degraded" }),
      requestFreshProbe: async () => "artifact://probe/fresh",
      eligibility: () => ({
        incidentId: "incident-1",
        snapshotId: "eligibility-7",
        sopIds: ["restart-service"],
      }),
      submitSelection,
    };
    const lead = createOpsTeamTools({ role: "incident-lead", ...common });
    await expect(
      lead.selectSop({ incidentId: "incident-1", sopId: "not-eligible" }),
    ).rejects.toThrow(/not eligible/i);
    await expect(
      lead.selectSop({ incidentId: "different", sopId: "restart-service" }),
    ).rejects.toThrow(/incident/i);
    await lead.selectSop({ incidentId: "incident-1", sopId: "restart-service" });
    expect(submitSelection).toHaveBeenCalledWith({
      incidentId: "incident-1",
      sopId: "restart-service",
      eligibilitySnapshotId: "eligibility-7",
      selectedBy: "incident-lead",
    });

    const diagnostician = createOpsTeamTools({ role: "diagnostician", ...common });
    await expect(
      diagnostician.selectSop({ incidentId: "incident-1", sopId: "restart-service" }),
    ).rejects.toThrow(/incident lead/i);
  });

  it("requests fresh read-only evidence instead of resolving disagreement by vote", async () => {
    const requestFreshProbe = vi.fn(async () => "artifact://probe/fresh");
    const tools = createOpsTeamTools({
      role: "independent-verifier",
      readEvidence: async () => ({ state: "unknown" }),
      requestFreshProbe,
      eligibility: () => ({ incidentId: "incident-1", snapshotId: "e-1", sopIds: [] }),
      submitSelection: async () => {},
    });
    await expect(tools.requestFreshProbe({
      incidentId: "incident-1",
      probeId: "process-state",
      reason: "diagnosis and raw evidence disagree",
    })).resolves.toBe("artifact://probe/fresh");
    expect(requestFreshProbe).toHaveBeenCalledOnce();
    expect(tools.names()).not.toContain("ops.vote");
  });
});
