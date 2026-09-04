/**
 * A step's recorded tool outputs must be what the TOOL returned, whatever
 * shape the runtime wrapped it in.
 *
 * `message.content` arrives three ways. Some runtimes put the tool's own string
 * there. A dsh session.jsonl puts an ARRAY of blocks, and the payload sits one
 * level deeper than it looks: verified against a live log on 2026-09-04, it is
 * `[{ type: "tool-result", toolCallId, content: [{ type: "text", text }] }]`.
 * The flatter `[{ type: "tool-result", text }]` that `fold.spec.ts` froze on
 * 2026-09-02 is the third shape.
 *
 * The runner used to `JSON.stringify` the whole array, so the recorded string
 * began with `[`. Every reader downstream parses a tool payload as an OBJECT,
 * so all of them skipped it in silence: the tenant renderer's spot map,
 * earnings map and settlement ledger, and every gate that checks a model's
 * claim against what it was actually handed. The tell was a run whose audit
 * table listed seventeen tool calls and whose brief still said "no tool spot;
 * not verified" — blindness that looks exactly like a tool never called.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AuditStore,
  CapabilityCatalog,
  loadTenants,
  type EcosystemTool,
  type LoadedTenant,
  type Provider,
} from "@helium/core";
import {
  registerProviders,
  runTenant,
  type ModelExecutor,
} from "../src/runner.js";

const TEAM = `manifestVersion: "2"
name: demo
roles:
  prober:
    requires: [tool.use]
    permissions: { tools: [echo] }
tasks:
  - id: only
    role: prober
    requires: [tool.use]
    prompt: call it
`;

function tenant(): LoadedTenant {
  const dir = mkdtempSync(join(tmpdir(), "helium-toolshape-"));
  mkdirSync(join(dir, "demo"));
  writeFileSync(
    join(dir, "demo", "tenant.yaml"),
    "tenant: demo\nenabled: true\nteam: team.yaml\nbudget: { usd: 1, tokens: 100000 }\n",
  );
  writeFileSync(join(dir, "demo", "team.yaml"), TEAM);
  return loadTenants(dir).tenants[0]!;
}

const echo: EcosystemTool = {
  name: "echo",
  description: "echo",
  paramsSchema: z.object({ q: z.string() }),
  mutating: false,
  async run() {
    return "{}";
  },
};

const provider: Provider = {
  id: "fake",
  capabilities: ["tool.use"],
  overheadTokens: 0,
  models: [{ id: "cheap", caps: ["tool.use"], usdIn: 1e-6, usdOut: 2e-6 }],
  async probe() {
    return true;
  },
  select() {
    return { targetId: "fake:cheap" as never, model: "cheap" };
  },
};

/** The payload a real tool returns: one JSON object, top-level. */
const PAYLOAD = '{"quotes":[{"ticker":"SPY","last":768.86}]}';

async function outputsFor(content: unknown): Promise<string[]> {
  const audit = new AuditStore(":memory:");
  const modelExecutor: ModelExecutor = {
    async run() {
      return {
        text: "ok",
        events: [
          {
            type: "tool/result",
            seq: 1,
            time: 1_000,
            data: {
              turn: 1,
              step: 1,
              message: { source: { kind: "tool", callId: "toolu_a" }, content },
            },
          },
        ] as never,
      };
    },
  };
  const catalog = new CapabilityCatalog();
  registerProviders(catalog, [provider]);
  const report = await runTenant({
    tenant: tenant(),
    audit,
    pluginsDir: "/nonexistent",
    stateRoot: mkdtempSync(join(tmpdir(), "helium-toolshape-state-")),
    providers: [provider],
    providersSkipped: [],
    tools: [echo],
    gates: [],
    channels: [],
    renderer: null,
    modelExecutor,
    catalog,
  });
  audit.close();
  return report.steps[0]?.toolOutputs ?? [];
}

describe("a step's recorded tool outputs", () => {
  it("unwraps the REAL dsh shape, whose payload sits one level deeper than it looks", async () => {
    // Verified against a live session.jsonl on 2026-09-04: the tool-result
    // block carries its own `content` array of text blocks. Reading only the
    // outer block's `text` finds nothing there and was the second half of this
    // bug — the first fix handled the flat shape and changed nothing in a real
    // run, which is why this fixture is the nested one.
    const outputs = await outputsFor([
      {
        type: "tool-result",
        toolCallId: "toolu_01PyrCXcvJ31N5juRKmj5dbK",
        content: [{ type: "text", text: PAYLOAD }],
      },
    ]);
    expect(outputs).toEqual([PAYLOAD]);
    const nested: unknown = JSON.parse(outputs[0]!);
    expect(Array.isArray(nested)).toBe(false);
  });

  it("unwraps the flat block shape too, so the older runtimes keep working", async () => {
    const outputs = await outputsFor([{ type: "tool-result", text: PAYLOAD }]);
    expect(outputs).toEqual([PAYLOAD]);
    // The assertion that matters is not the string equality above but this:
    // every reader downstream does exactly this parse, and against the old
    // stringified array it threw or returned an Array and was skipped.
    const parsed: unknown = JSON.parse(outputs[0]!);
    expect(Array.isArray(parsed)).toBe(false);
    expect(
      (parsed as { quotes: Array<{ last: number }> }).quotes[0]!.last,
    ).toBe(768.86);
  });

  it("passes a plain string through untouched", async () => {
    expect(await outputsFor(PAYLOAD)).toEqual([PAYLOAD]);
  });

  it("keeps a block it cannot read, rather than dropping the payload", async () => {
    // Losing a payload silently is how the array shape went unnoticed for a
    // whole provider. An unrecognised block is recorded as itself.
    const outputs = await outputsFor([{ type: "image", data: "…" }]);
    expect(outputs).toEqual(['{"type":"image","data":"…"}']);
  });
});
