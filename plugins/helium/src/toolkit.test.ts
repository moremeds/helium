import { describe, expect, it } from "vitest";
import { registerEcosystemTools } from "./toolkit.js";
import type { TenantTool } from "./tenant-tools.js";

/**
 * A tenant tool carries its OWN dsh parameter spec. `DSH_PARAMS` is now just
 * the two tools core owns, so a fixture built from the host's map could never
 * exercise the path a real tenant takes.
 */
const tenantTools = (): TenantTool[] => [
  {
    name: "alpha_probe",
    description: "probe",
    paramsSchema: { parse: (v: unknown) => v } as never,
    mutating: false,
    dshParams: { q: { type: "string", required: true, description: "q" } },
    run: async () => JSON.stringify({ ok: true }),
  },
  {
    name: "beta_probe",
    description: "probe",
    paramsSchema: { parse: (v: unknown) => v } as never,
    mutating: false,
    dshParams: { n: { type: "number", required: true, description: "n" } },
    run: async () => JSON.stringify({ ok: true }),
  },
];

describe("registerEcosystemTools", () => {
  it("registers a tenant tool from the spec the tool itself carries", () => {
    const registered: { name: string; parameters: unknown }[] = [];
    registerEcosystemTools(
      {
        tools: {
          register: (d: { name: string; parameters: unknown }) => {
            registered.push(d);
            return () => {};
          },
        },
      } as never,
      tenantTools(),
    );
    expect(registered.map((d) => d.name).sort()).toEqual([
      "alpha_probe",
      "beta_probe",
    ]);
    // `defineTool` compiles the spec into a JSON schema, so assert the
    // property the tenant declared survived rather than object identity.
    expect(JSON.stringify(registered[0]!.parameters)).toContain("q");
    expect(JSON.stringify(registered[1]!.parameters)).toContain("n");
  });

  it("fails loudly when a tool has no dsh parameter spec", () => {
    expect(() =>
      registerEcosystemTools({ tools: { register: () => () => {} } } as never, [
        {
          name: "unmapped",
          description: "",
          paramsSchema: {} as never,
          mutating: false,
          run: async () => "",
        },
      ]),
    ).toThrow(/no dsh parameter spec/);
  });
});
