import { resolve } from "node:path";
import { loadTenants } from "@helium/core";
import type { RunOptions } from "../../src/runner.js";

const PLUGINS = resolve(import.meta.dirname, "../../../../plugins");

/** The built `fake-tenant`, in tool-only mode, writing under `stateRoot`. */
export function tenantFixture(stateRoot: string): Omit<RunOptions, "audit"> & {
  tenant: NonNullable<ReturnType<typeof loadTenants>["tenants"][number]>;
} {
  const { tenants } = loadTenants(PLUGINS);
  const tenant = tenants.find((entry) => entry.spec.tenant === "fake-tenant")!;
  return {
    tenant,
    pluginsDir: PLUGINS,
    stateRoot,
    env: { HELIUM_STATE_ROOT: stateRoot },
    providers: [],
    providersSkipped: [],
    tools: [],
    gates: [],
    channels: [],
    phase: "premarket",
    now: (): Date => new Date("2026-09-05T00:00:00Z"),
  };
}
