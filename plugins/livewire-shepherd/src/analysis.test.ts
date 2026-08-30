import { describe, expect, it } from "vitest";
import {
  createShepherdOutputContractRegistry,
  loadShepherdTeamManifest,
  selectShepherdTeamVariant,
} from "./analysis.js";

describe("Livewire Shepherd analysis composition", () => {
  it("selects the smallest sufficient team", () => {
    expect(selectShepherdTeamVariant({ requiresPit: false, hasSourceConflict: false })).toBe("repair");
    expect(selectShepherdTeamVariant({ requiresPit: false, hasSourceConflict: true })).toBe("source-conflict");
    expect(selectShepherdTeamVariant({ requiresPit: true, hasSourceConflict: false })).toBe("pit");
  });

  it("loads every committed manifest and composes built-in plus Shepherd contracts", () => {
    expect(loadShepherdTeamManifest("repair").name).toBe("livewire-shepherd-repair");
    expect(loadShepherdTeamManifest("source-conflict").name).toBe("livewire-shepherd-source-conflict");
    expect(loadShepherdTeamManifest("pit").name).toBe("livewire-shepherd-pit");
    const registry = createShepherdOutputContractRegistry();
    expect(registry.has("ClaimSet.v1")).toBe(true);
    expect(registry.has("ShepherdClaimSet.v1")).toBe(true);
    expect(registry.has("ShepherdRepairProposal.v1")).toBe(true);
  });
});
