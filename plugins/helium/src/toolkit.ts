/**
 * dsh in-process tool registration: bridges the merged tenant tool catalog
 * onto ctx.tools for dsh agents / interactive Web UI sessions. MCP stdio
 * (plugins/helium/src/mcp/server.ts) is the other exposure surface for the
 * exact same tools.
 *
 * dsh-tools API cited against the installed @deepseek-ai/dsh-tools
 * 0.1.2-alpha.3 package (plugins/helium/node_modules/@deepseek-ai/dsh-tools),
 * re-measured 2026-09-01 during the version bump — the signatures are
 * unchanged from 0.1.1-rc.2, only the emitted line numbers moved:
 * - ToolRuntime.register(definition: ToolDefinition): () => void
 *   (lib/types/index.d.ts:602; impl lib/index.js:2774 — throws TypeError
 *   when `output` is missing/malformed, lib/index.js:2777).
 * - defineTool<const S extends ParameterSchemaSpec, const O extends
 *   ValueSchemaSpec>(options): ToolDefinition (lib/types/schema.d.ts:239).
 *   `output` is mandatory on DefineToolOptions (schema.d.ts:186-193) — a
 *   missing/malformed output is exactly what register() rejects above.
 * - ParameterSchemaSpec is a flat map of property name -> ValueSchemaSpec &
 *   { required?: true } (schema.d.ts:74-84); an object-typed property MUST
 *   set `additionalProperties: boolean` (ObjectValueSchemaSpec,
 *   schema.d.ts:58-62) — not zod.
 * @module dsh-plugin-helium/toolkit
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { ParameterSchemaSpec } from "@deepseek-ai/dsh-tools";
import type { Context } from "@deepseek-ai/cordis";
import type { EcosystemTool } from "@helium/core";

const thesisReadParams = {
  job: { type: "string", required: true, description: "Job name" },
} satisfies ParameterSchemaSpec;

const thesisWriteParams = {
  job: { type: "string", required: true, description: "Job name" },
  content: {
    type: "string",
    required: true,
    description: "The full rewritten thesis, max 64 KiB",
  },
} satisfies ParameterSchemaSpec;

/**
 * The two tools CORE owns. Every other tool is supplied by a tenant and
 * carries its own `dshParams`, which is what makes the plug-in contract
 * closed: a hardcoded map can only name tools the host already knows.
 */
const DSH_PARAMS = {
  thesis_read: thesisReadParams,
  thesis_write: thesisWriteParams,
} as const satisfies Record<string, ParameterSchemaSpec>;

export type ToolkitCtx = Pick<Context, "tools">;

export function registerEcosystemTools(
  ctx: ToolkitCtx,
  tools: EcosystemTool[],
): void {
  for (const tool of tools) {
    // A tenant tool carries its OWN dsh parameter spec: the hardcoded map below
    // can only ever name tools the host already knows, which no tenant-supplied
    // tool can satisfy. The map stays as the fallback for core's own tools.
    const carried = (tool as { dshParams?: ParameterSchemaSpec }).dshParams;
    const parameters =
      carried ??
      (DSH_PARAMS[tool.name as keyof typeof DSH_PARAMS] as
        ParameterSchemaSpec | undefined);
    if (!parameters)
      throw new Error(`toolkit: no dsh parameter spec for tool "${tool.name}"`);
    ctx.tools.register(
      defineTool({
        name: tool.name,
        description: tool.description,
        parameters,
        output: {
          schema: { type: "string" },
          render: (_args, value) => [{ type: "text", text: String(value) }],
        },
        execute: async (args) =>
          await tool.run(args as Record<string, unknown>),
      }),
    );
  }
}
