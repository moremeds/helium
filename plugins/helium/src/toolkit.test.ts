import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildTools } from "@helium/v1-compat";
import { registerEcosystemTools } from "./toolkit.js";

const tools = () =>
  buildTools({
    argonBase: "http://127.0.0.1:8400",
    apexBase: "http://127.0.0.1:8322",
    livewireDb: "/tmp/livewire.duckdb",
    stateRoot: mkdtempSync(join(tmpdir(), "helium-tk-")),
  });

describe("registerEcosystemTools", () => {
  it("registers every tool buildTools produces", () => {
    const registered: { name: string }[] = [];
    registerEcosystemTools(
      {
        tools: {
          register: (d: { name: string }) => {
            registered.push(d);
            return () => {};
          },
        },
      } as never,
      tools(),
    );
    expect(registered.map((d) => d.name).sort()).toEqual(
      tools()
        .map((t) => t.name)
        .sort(),
    );
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
