/** Capability boundary for the optional, read-only Ops analysis team. */

export const OPS_TEAM_ROLES = [
  "diagnostician",
  "independent-verifier",
  "incident-lead",
  "reporter",
] as const;
export type OpsTeamRole = (typeof OPS_TEAM_ROLES)[number];

export interface EligibilitySnapshot {
  incidentId: string;
  snapshotId: string;
  sopIds: readonly string[];
}

export interface OpsSopSelection {
  incidentId: string;
  sopId: string;
  eligibilitySnapshotId: string;
  selectedBy: "incident-lead";
}

export interface FreshProbeRequest {
  incidentId: string;
  probeId: string;
  reason: string;
}

export interface OpsTeamToolOptions {
  role: OpsTeamRole;
  readEvidence(ref: string): Promise<unknown>;
  requestFreshProbe(request: FreshProbeRequest): Promise<string>;
  /** Supplied by the deterministic controller, never computed by a model. */
  eligibility(): EligibilitySnapshot;
  submitSelection(selection: OpsSopSelection): Promise<void>;
}

const READ_ONLY_NAMES = ["ops.evidence.read", "ops.probe.request"] as const;

export class OpsTeamTools {
  readonly #options: OpsTeamToolOptions;

  constructor(options: OpsTeamToolOptions) {
    this.#options = options;
  }

  names(): string[] {
    return this.#options.role === "incident-lead"
      ? [...READ_ONLY_NAMES, "ops.sop.select"]
      : [...READ_ONLY_NAMES];
  }

  async readEvidence(ref: string): Promise<unknown> {
    if (!ref.startsWith("artifact://")) throw new Error("evidence ref must be an artifact ref");
    return this.#options.readEvidence(ref);
  }

  async requestFreshProbe(request: FreshProbeRequest): Promise<string> {
    if (request.incidentId.length === 0 || request.probeId.length === 0 || request.reason.length === 0) {
      throw new Error("fresh probe request requires incident, probe and reason");
    }
    const ref = await this.#options.requestFreshProbe(request);
    if (!ref.startsWith("artifact://")) throw new Error("fresh probe did not return an artifact ref");
    return ref;
  }

  async selectSop(input: { incidentId: string; sopId: string }): Promise<void> {
    if (this.#options.role !== "incident-lead") {
      throw new Error("only the incident lead may submit an SOP selection");
    }
    const snapshot = this.#options.eligibility();
    if (snapshot.incidentId !== input.incidentId) {
      throw new Error("eligibility snapshot belongs to a different incident");
    }
    if (!snapshot.sopIds.includes(input.sopId)) {
      throw new Error(`SOP ${input.sopId} is not eligible in snapshot ${snapshot.snapshotId}`);
    }
    await this.#options.submitSelection({
      incidentId: input.incidentId,
      sopId: input.sopId,
      eligibilitySnapshotId: snapshot.snapshotId,
      selectedBy: "incident-lead",
    });
  }
}

export function createOpsTeamTools(options: OpsTeamToolOptions): OpsTeamTools {
  return new OpsTeamTools(options);
}
