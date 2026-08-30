import { createHash } from "node:crypto";
import { canonicalJson, type TeamRunProjection } from "@helium/core";
import type { JobSpec } from "@helium/v1-compat";
import type { TriggerEvent } from "./sensor.js";
import type { TeamRunInput } from "./team-controller.js";

export interface ShadowAdapterOptions {
  enabled: boolean;
  run(input: TeamRunInput): Promise<Pick<TeamRunProjection, "state">>;
}

/** Fan-out adapter: v1 always starts first; shadow can only add its own records. */
export class ShadowAdapter {
  constructor(private readonly options: ShadowAdapterOptions) {}

  async handle(
    job: JobSpec,
    event: TriggerEvent,
    continueV1: () => void,
  ): Promise<void> {
    continueV1();
    if (!this.options.enabled) return;
    const content = canonicalJson({ job: job.name, event });
    const digest = createHash("sha256").update(content).digest("hex");
    await this.options.run({
      caseId: `shadow-${digest.slice(0, 24)}`,
      subject: `${job.name}:${event.kind}`,
      prompt: job.prompt,
      inputArtifacts: [
        {
          ref: `artifact://shadow-trigger/${digest}`,
          hash: `sha256:${digest}`,
          content,
        },
      ],
    });
  }
}
