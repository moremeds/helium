/**
 * dsh in-process tool registration: bridges the buildTools() ecosystem
 * toolkit onto ctx.tools for dsh agents / interactive Web UI sessions.
 * MCP stdio (packages/core/src/mcp/server.ts) is the other exposure surface
 * for the exact same tools.
 *
 * dsh-tools API cited against the installed @deepseek-ai/dsh-tools
 * 0.1.1-rc.2 package (plugins/helium/node_modules/@deepseek-ai/dsh-tools):
 * - ToolRuntime.register(definition: ToolDefinition): () => void
 *   (lib/types/index.d.ts:603; impl lib/index.js:2762 — throws TypeError
 *   when `output` is missing/malformed, lib/index.js:2765).
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

const argonApiParams = {
  path: {
    type: "string",
    required: true,
    description: "Read-only argon path, e.g. /api/rates/snapshot",
  },
  query: {
    type: "object",
    additionalProperties: true,
    description: "Optional query parameters",
  },
} satisfies ParameterSchemaSpec;

const argonRescanParams = {
  path: {
    type: "string",
    required: true,
    description: "Allow-listed argon rescan path",
  },
} satisfies ParameterSchemaSpec;

const argonAiAnalysisParams = {
  path: {
    type: "string",
    required: true,
    description: "Allow-listed argon ai-analysis path",
  },
} satisfies ParameterSchemaSpec;

const apexApiParams = {
  path: {
    type: "string",
    required: true,
    description: "apex path: /health or /v1/...",
  },
  query: {
    type: "object",
    additionalProperties: true,
    description: "Optional query parameters",
  },
} satisfies ParameterSchemaSpec;

const apexComputeParams = {
  path: {
    type: "string",
    required: true,
    description: "Allow-listed apex compute path",
  },
} satisfies ParameterSchemaSpec;

const livewireSqlParams = {
  sql: {
    type: "string",
    required: true,
    description: "A single read-only SELECT or WITH statement",
  },
  maxRows: { type: "integer", description: "Row cap, default 200" },
} satisfies ParameterSchemaSpec;

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

/** dsh parameter specs, one per tool name. Kept in lockstep with buildTools() by a test. */
const DSH_PARAMS = {
  argon_api: argonApiParams,
  argon_rescan: argonRescanParams,
  argon_ai_analysis: argonAiAnalysisParams,
  apex_api: apexApiParams,
  apex_compute: apexComputeParams,
  livewire_sql: livewireSqlParams,
  thesis_read: thesisReadParams,
  thesis_write: thesisWriteParams,
} as const satisfies Record<string, ParameterSchemaSpec>;

export type ToolkitCtx = Pick<Context, "tools">;

export function registerEcosystemTools(
  ctx: ToolkitCtx,
  tools: EcosystemTool[],
): void {
  for (const tool of tools) {
    const parameters = DSH_PARAMS[tool.name as keyof typeof DSH_PARAMS] as
      ParameterSchemaSpec | undefined;
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
