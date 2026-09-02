/**
 * Presenting an `Executor` to the shared execution-boundary conformance
 * harness.
 *
 * This lives in the provider SDK because it is the seam every provider plugin
 * shares: one suite grades every executor, so a second execution backend
 * cannot quietly grade itself on an easier exam.
 * @module @helium/provider-sdk/boundary
 */
import { randomUUID } from "node:crypto";
import type { Executor, IsolationClass, WorkOrder } from "@helium/core";

/**
 * The shape the shared execution-boundary harness accepts as a subject.
 *
 * Declared structurally rather than imported from `@helium/contracts`, so
 * production code carries no dependency on the contract suite. The harness
 * type is matched by structure; if it ever changes, the conformance contract
 * test stops compiling, which is where that breakage belongs.
 */
export interface BoundarySubjectLike {
  readonly name: string;
  readonly dialect?: "claude-cli" | "codex-cli";
  readonly declaredIsolationClass: IsolationClass;
  invoke(input: {
    prompt: string;
    allowedTools: string[];
    mcpConfigPath?: string;
    expectedWorkspace: string;
    env: Record<string, string>;
  }): Promise<{ text?: string }>;
}

/**
 * Present an `Executor` as a conformance subject, so every executor is graded
 * by the ONE suite Phase 0 shipped rather than by a second one of its own.
 */
export function asBoundarySubject(
  executor: Executor,
  name: string,
  dialect?: "claude-cli" | "codex-cli",
): BoundarySubjectLike {
  return {
    name,
    ...(dialect === undefined ? {} : { dialect }),
    declaredIsolationClass: executor.isolationClass,
    async invoke(input) {
      const work: WorkOrder = {
        id: `boundary-${randomUUID()}`,
        role: "execution-boundary-probe",
        taskClass: "conformance.boundary",
        requires: [],
        constraints: {
          tools: input.allowedTools,
          mutations: "forbidden",
          minIsolationClass: executor.isolationClass,
        },
        inputs: { artifacts: [], prompt: input.prompt },
        acceptance: { outputSchema: "boundary-report-v1" },
      };
      const result = await executor.run(work, new AbortController().signal, {
        workspace: input.expectedWorkspace,
        env: input.env,
        allowedTools: input.allowedTools,
        mcpConfigPath: input.mcpConfigPath,
      });
      return {
        text: typeof result.structured === "string" ? result.structured : undefined,
      };
    },
  };
}
