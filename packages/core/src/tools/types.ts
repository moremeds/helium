/**
 * Ecosystem-tool contract, shared by every helium-owned tool and both
 * exposure surfaces (in-process dsh registration, MCP stdio).
 * @module @helium/core/tools/types
 */
import type { z } from "zod";

/** Test-only injection point for the HTTP tools. */
export interface ToolRunContext {
  fetchImpl?: typeof fetch;
}

export interface EcosystemTool {
  name: string;
  description: string;
  paramsSchema: z.ZodType;
  /** Filtered out unless the job's allowMutations flag permits it. */
  mutating: boolean;
  /** Returns a JSON string; ctx is test-only injection. */
  run(args: Record<string, unknown>, ctx?: ToolRunContext): Promise<string>;
}

/**
 * One entry in a build's tool vocabulary: every name a build knows about,
 * independent of which are configured in the running environment. The
 * vocabulary itself is assembled by whoever owns the concrete toolkits; core
 * only defines its shape and consumes it in the selection filter.
 */
export interface ToolVocabularyEntry {
  mutating: boolean;
  /** Absent means the tool is always present in a built catalog. */
  requiresEnv?: string;
}
