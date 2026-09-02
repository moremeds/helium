/**
 * The tool contract, shared by every helium-owned tool and both exposure
 * surfaces (in-process registration and MCP stdio).
 *
 * Core defines the SHAPE only. Constructing a tool means knowing a business
 * domain, and doctrine 2 bans that knowledge from core: concrete tools live in
 * `plugins/<tenant>/tools/index.ts`.
 * @module @helium/core/tools
 */
import type { z } from "zod";

/** Test-only injection point for tools that reach the network. */
export interface ToolRunContext {
  fetchImpl?: typeof fetch;
}

export interface EcosystemTool {
  name: string;
  description: string;
  paramsSchema: z.ZodType;
  /** Filtered out unless the run's mutation flag permits it. */
  mutating: boolean;
  /** Returns a JSON string; ctx is test-only injection. */
  run(args: Record<string, unknown>, ctx?: ToolRunContext): Promise<string>;
}

/**
 * One entry in a build's tool vocabulary: every name a build knows about,
 * independent of which are configured in the running environment.
 */
export interface ToolVocabularyEntry {
  mutating: boolean;
  /** Absent means the tool is always present in a built catalog. */
  requiresEnv?: string;
}
