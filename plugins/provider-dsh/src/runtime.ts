/**
 * Booting the in-process dsh runtime, and the one adapter between helium's
 * tool contract and dsh's.
 *
 * This is the file the rest of the repo never has to read. `dsh-app-boot`'s
 * `loadProfile`/`initProfile` is deliberately NOT used: it wants a
 * `$DSH_HOME/profiles/<name>` tree, a pnpm install inside it and a symlink
 * fallback chain, all to produce the same `Context` the nine `ctx.plugin`
 * calls below produce directly. Nothing here writes at construction time and
 * nothing needs a credential, which is why `DshProvider.probe()` can be honest
 * for free — `MISSING_CREDENTIAL` is raised at request time, not at boot.
 * @module dsh-plugin-provider-dsh/runtime
 */
import { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { EcosystemTool } from "@helium/core";
import type {} from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-llm";
import type {} from "@deepseek-ai/dsh-session";
import type {} from "@deepseek-ai/dsh-session-persistence";
import type {} from "@deepseek-ai/dsh-subagent";
import type {} from "@deepseek-ai/dsh-system-prompt";

/**
 * The name `dsh-subagent-spawn-in-process` registers itself under. It is the
 * SUBAGENT TRANSPORT, not an LLM vendor: it says how a child agent is
 * materialised (in this process), not who serves the tokens. The vendor is
 * `agentOptions.provider`. Passing a vendor name here — this shipped once as
 * `"deepseek"` — resolves to no transport and the start fails.
 */
export const SUBAGENT_TRANSPORT = "spawn";

export interface DshRuntimeOptions {
  /** Where the jsonl session log is written. Created lazily, on first session. */
  sessionRoot: string;
  /** pi-ai route id, e.g. `anthropic`. */
  llmProvider: string;
  /** Env var NAME holding the credential; pi-ai resolves it per request. */
  apiKeyEnv: string;
  /** Extra request headers for the route; see `authHeaders`. */
  headers?: Record<string, string>;
}

/**
 * Anthropic takes two credential shapes and they do NOT go in the same header.
 * An API key (`sk-ant-api…`) goes on `x-api-key`, which is what pi-ai's
 * `apiKeyEnv` does on its own. A subscription OAuth token (`sk-ant-oat…`)
 * goes on `Authorization: Bearer` together with the `oauth-2025-04-20` beta —
 * verified 2026-09-02 against `POST /v1/messages`, where the OAuth form
 * answered 200 and this machine's API key answered 400 (no credit balance).
 *
 * The value is read once at boot because pi-ai's `headers` are literal; the
 * per-request credential seam only feeds `x-api-key`.
 */
export function authHeaders(token: string | undefined): Record<string, string> {
  if (token === undefined || !token.startsWith("sk-ant-oat")) return {};
  return { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" };
}

/**
 * Nine plugins, in dependency order. `dsh-system-prompt` is not optional:
 * `dsh-tools` injects `systemPrompt` and its absence is a hard boot failure.
 * `dsh-llm-pi-ai` and `dsh-subagent-spawn-in-process` export no `default` —
 * they are namespace plugins (`apply`/`inject`/`name`), so the module object
 * itself is what cordis takes.
 */
export async function createDshContext(
  options: DshRuntimeOptions,
): Promise<Context> {
  const ctx = new Context();
  ctx.plugin((await import("@deepseek-ai/dsh-llm")).default);
  ctx.plugin((await import("@deepseek-ai/dsh-session")).default);
  ctx.plugin((await import("@deepseek-ai/dsh-system-prompt")).default, {
    includeHarnessIdentity: false,
    includeRuntimeContext: false,
  });
  ctx.plugin((await import("@deepseek-ai/dsh-tools")).default);
  // dsh-agent-loop injects `sessionProjections`; without the registry the loop
  // plugin stays inactive and `agents.create()` still reports no factory.
  ctx.plugin((await import("@deepseek-ai/dsh-session-projection")).default);
  ctx.plugin((await import("@deepseek-ai/dsh-agent")).default);
  // The agent factory itself. Without it `agents.create()` fails with "no
  // agent factory registered" — dsh-agent is the registry, not the loop.
  ctx.plugin((await import("@deepseek-ai/dsh-agent-loop")).default);
  ctx.plugin((await import("@deepseek-ai/dsh-subagent")).default);
  ctx.plugin((await import("@deepseek-ai/dsh-session-persistence-jsonl")).default, {
    root: options.sessionRoot,
    compression: "none",
  });
  ctx.plugin(await import("@deepseek-ai/dsh-subagent-spawn-in-process"), {
    providerName: SUBAGENT_TRANSPORT,
  });
  ctx.plugin(await import("@deepseek-ai/dsh-llm-pi-ai"), {
    providers: {
      [options.llmProvider]: {
        apiKeyEnv: options.apiKeyEnv,
        ...(options.headers === undefined ? {} : { headers: options.headers }),
      },
    },
  });
  // Plugin application is async: without this the services exist but the LLM
  // route is not registered yet, and `listProviders()` comes back empty.
  await ctx.fiber.await();
  return ctx;
}

/** A tenant tool's own dsh parameter spec, carried alongside the zod schema. */
type DshParams = Record<string, { type: string; required?: true; description?: string }>;

/**
 * Register helium tools as dsh tools for the life of one step.
 *
 * They must exist BEFORE the child starts: `toolFilter` is applied as a scoped
 * `tools.restrict()` with loud unknown-name validation, so an allow-list
 * naming a tool nobody registered throws instead of quietly narrowing.
 *
 * Every tool's canonical output is a string, because `EcosystemTool.run`
 * returns a JSON string and re-parsing it here would invent a schema the
 * tenant never declared.
 */
export function registerEcosystemTools(
  ctx: Context,
  tools: readonly EcosystemTool[],
): () => void {
  const disposers = tools.map((tool) => {
    // ponytail: a tool with no `dshParams` is registered with no parameters
    // rather than translated from its zod schema. Every tenant tool in this
    // repo carries dshParams; a zod->JSON-Schema translation is the ceiling if
    // one ever does not.
    const parameters = ((tool as { dshParams?: DshParams }).dshParams ?? {}) as DshParams;
    return ctx.tools.register(
      defineTool({
        name: tool.name,
        description: tool.description,
        parameters: parameters as never,
        output: {
          schema: { type: "string" } as const,
          render: (_args: unknown, value: string) => [{ type: "text" as const, text: value }],
        },
        execute: async (args: unknown) => tool.run(args as Record<string, unknown>),
      }),
    );
  });
  return () => {
    for (const dispose of disposers) dispose();
  };
}

/**
 * How a tenant's built tools reach this provider.
 *
 * `Provider.run` is handed the work order (tool NAMES) and the selection. The
 * runner puts the implementations in `selection.options.tools`, which is the
 * bag core never reads into — so the dataflow is explicit and scoped to one
 * step, and `packages/cli` still names nothing about dsh.
 */
export function selectedTools(
  options: Record<string, unknown> | undefined,
): EcosystemTool[] {
  const tools = options?.tools;
  return Array.isArray(tools) ? (tools as EcosystemTool[]) : [];
}
