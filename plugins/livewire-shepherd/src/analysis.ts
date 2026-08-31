import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseTeamYaml, type TeamManifest } from "@helium/core";
import { createBuiltinOutputContractRegistry } from "dsh-plugin-helium/output-contract-registry";
import { registerShepherdOutputContracts } from "./output-contracts.js";

export const SHEPHERD_TEAM_VARIANTS = ["repair", "source-conflict", "pit"] as const;
export type ShepherdTeamVariant = (typeof SHEPHERD_TEAM_VARIANTS)[number];

export function createShepherdOutputContractRegistry() {
  return registerShepherdOutputContracts(createBuiltinOutputContractRegistry());
}

export function shepherdManifestPath(variant: ShepherdTeamVariant): string {
  return resolve(import.meta.dirname, "../../../teams", `livewire-shepherd-${variant}.yaml`);
}

export function loadShepherdTeamManifest(
  variant: ShepherdTeamVariant,
  path = shepherdManifestPath(variant),
): TeamManifest {
  return parseTeamYaml(readFileSync(path, "utf8"));
}

export function selectShepherdTeamVariant(input: {
  requiresPit: boolean;
  hasSourceConflict: boolean;
}): ShepherdTeamVariant {
  if (input.requiresPit) return "pit";
  if (input.hasSourceConflict) return "source-conflict";
  return "repair";
}
