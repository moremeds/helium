/**
 * Deterministic fake LLM for composition tests (provider id `fake`).
 * It calls each non-output tool once (date-like string args get 2099-12-31,
 * so the as-of clamp is observable), then answers through
 * `structured_output` with a value built from that tool's schema (enums take
 * their first member). Every call logs the model and the tool names it saw.
 * HELIUM_FAKE_MODE=hang waits until aborted; =noschema never submits output.
 */
import { LlmAdapter } from "@deepseek-ai/dsh-llm";

export const name = "helium-fake-llm";
export const inject = ["llm"];

type Schema = { type?: string; enum?: unknown[]; properties?: Record<string, Schema>; items?: Schema };

function sample(schema: Schema | undefined, key = ""): unknown {
  if (schema?.enum?.length) return schema.enum[0];
  switch (schema?.type) {
    case "object":
      return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([k, v]) => [k, sample(v, k)]));
    case "array":
      return [];
    case "number":
    case "integer":
      return 1;
    case "boolean":
      return true;
    default:
      return /date/i.test(key) ? "2099-12-31" : key === "symbol" ? "AAA" : "x";
  }
}

let calls = 0;

class Fake extends LlmAdapter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async *stream(o: any): AsyncGenerator<any> {
    const n = ++calls;
    const tools: { name: string; parameters?: Schema; inputSchema?: Schema }[] = o.tools ?? [];
    process.stderr.write(`[fake] model=${o.model} tools=${JSON.stringify(tools.map((t) => t.name).sort())}\n`);
    if (process.env.HELIUM_FAKE_MODE === "hang") {
      await new Promise((_, reject) => o.signal?.addEventListener("abort", () => reject(o.signal.reason ?? new Error("aborted"))));
    }
    const history = JSON.stringify(o.messages ?? []);
    const own = tools.find((t) => t.name !== "structured_output" && !history.includes(`"${t.name}"`));
    const out = tools.find((t) => t.name === "structured_output");
    const pick = own ?? (process.env.HELIUM_FAKE_MODE === "noschema" ? undefined : out);
    if (pick !== undefined) {
      const args = JSON.stringify(sample({ type: "object", ...(pick.parameters ?? pick.inputSchema) }));
      const id = `call-${n}`;
      yield { type: "block-start", index: 0, blockType: "tool-call" };
      yield { type: "tool-call-delta", index: 0, id, name: pick.name, argumentsDelta: args };
      yield { type: "block-end", index: 0, block: { type: "tool-call", id, name: pick.name, arguments: args } };
      yield { type: "usage", usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 7, cacheWriteTokens: 3 } };
      yield { type: "finish", reason: { kind: "tool-calls" } };
      return;
    }
    const text = `fake reply from ${o.model}`;
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text };
    yield { type: "block-end", index: 0, block: { type: "text", text } };
    yield { type: "usage", usage: { inputTokens: 100, outputTokens: 10 } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

export function apply(ctx: { llm: { registerAdapter(ids: string[], a: unknown): void } }): void {
  ctx.llm.registerAdapter(["fake"], new Fake());
}
