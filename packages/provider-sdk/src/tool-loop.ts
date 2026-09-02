/**
 * The parts of a tool-calling loop that are the SAME for every vendor.
 *
 * The loop itself is not shared: Anthropic answers with `tool_use` content
 * blocks on a `messages` array, OpenAI's Responses API emits `function_call`
 * items on an SSE stream, and pretending those are one shape costs more than
 * the two loops it saves. What IS shared is everything around them — how a
 * helium tool becomes a JSON-Schema parameter object, how a call is executed
 * without letting a throwing tool kill the run, and how the loop is stopped
 * before it can spin forever on a model that keeps asking.
 * @module @helium/provider-sdk/tool-loop
 */
import type { EcosystemTool, LogEvent } from "@helium/core";

/**
 * A tenant tool's dsh parameter spec, carried on the tool object alongside its
 * zod schema. It is already almost JSON Schema — a flat property map — which is
 * why nothing here takes a zod-to-JSON-Schema dependency to read it.
 */
type DshParams = Record<
  string,
  { type: string; required?: true; description?: string }
>;

export interface ToolSpec {
  name: string;
  description: string;
  /** A JSON Schema object, ready for either vendor's tool declaration. */
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

/**
 * Ceiling on how many times a model may answer with tool calls before the loop
 * gives up and returns what it has.
 *
 * A model that misreads a tool result can ask for the same thing forever, and
 * every turn re-sends the whole transcript — so an unbounded loop is not a slow
 * run, it is a quadratic one against a metered API. Eight is above anything the
 * option-wizard team needs (its longest role calls five tools once each) and
 * far below where the spend becomes interesting.
 */
export const MAX_TOOL_TURNS = 8;

/**
 * Translate helium tools into the vendor-neutral half of a tool declaration.
 *
 * A tool with no `dshParams` is declared with no parameters rather than guessed
 * at — the same choice `plugins/provider-dsh` already makes. Declaring invented
 * parameters would be worse than declaring none: the model would call the tool
 * with arguments the tool never reads and cannot report as wrong.
 */
export function toolSpecs(tools: readonly EcosystemTool[]): ToolSpec[] {
  return tools.map((tool) => {
    const params = ((tool as { dshParams?: DshParams }).dshParams ??
      {}) as DshParams;
    const properties: Record<string, { type: string; description?: string }> =
      {};
    const required: string[] = [];
    for (const [name, spec] of Object.entries(params)) {
      properties[name] = {
        type: spec.type,
        ...(spec.description === undefined
          ? {}
          : { description: spec.description }),
      };
      if (spec.required === true) required.push(name);
    }
    return {
      name: tool.name,
      description: tool.description,
      parameters: { type: "object" as const, properties, required },
    };
  });
}

export interface ToolCallOutcome {
  /** What goes back to the model. Never empty: silence reads as success. */
  content: string;
  isError: boolean;
}

/**
 * Execute one tool call and turn every failure into TEXT the model can read.
 *
 * Nothing here throws. A tool that rejects — a bad ticker, a dead endpoint, an
 * argument that fails its own zod parse — is ordinary and the model is the
 * right party to react to it: it can drop that ticker and carry on. Letting the
 * rejection propagate would instead fail the whole step, which is the silent
 * degradation this tenant already paid for once (a refusing chain reading as a
 * considered "no trades today").
 *
 * A call naming a tool that was not offered is different in kind — it means the
 * allow-list and the declaration disagree — so it is reported as an error to the
 * model AND is visible as such in the span.
 */
export async function runToolCall(
  tools: readonly EcosystemTool[],
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallOutcome> {
  const tool = tools.find((entry) => entry.name === name);
  if (tool === undefined) {
    return {
      content: `no tool named ${name} is available to this role`,
      isError: true,
    };
  }
  try {
    const out = await tool.run(args);
    return {
      content: out === "" ? "(the tool returned nothing)" : out,
      isError: false,
    };
  } catch (error: unknown) {
    return {
      content: `${name} failed: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}

/** Best-effort JSON argument parse; a model occasionally emits a bare string. */
export function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === "object" && raw !== null)
    return raw as Record<string, unknown>;
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * The two events `foldSessionLog` needs to bill a tool call.
 *
 * `callId` goes at `message.source.callId` on the result because that is where
 * the fold reads it; getting that path wrong once already meant every tool call
 * happened and the audit table showed none.
 */
export function toolCallEvents(
  seq: number,
  turn: number,
  callId: string,
  name: string,
  startedAt: number,
  outcome: ToolCallOutcome,
): LogEvent[] {
  return [
    {
      type: "tool/call",
      seq,
      time: startedAt,
      data: { turn, step: 1, callId, name },
    },
    {
      type: "tool/result",
      seq: seq + 1,
      time: Date.now(),
      data: {
        message: {
          source: { callId },
          content: outcome.content,
          isError: outcome.isError,
        },
      },
    },
  ];
}

/**
 * How a tenant's built tools reach a provider.
 *
 * `Provider.run` is handed the work order (tool NAMES) and the selection; the
 * runner puts the implementations in `selection.options.tools`, the bag core
 * never reads into. That keeps the dataflow explicit and scoped to one step,
 * where a module-level global would leak between concurrent runs.
 */
export function selectedTools(
  options: Record<string, unknown> | undefined,
): EcosystemTool[] {
  const tools = options?.tools;
  return Array.isArray(tools) ? (tools as EcosystemTool[]) : [];
}
