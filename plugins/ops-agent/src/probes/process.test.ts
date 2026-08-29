import { describe, expect, it } from "vitest";
import { ObservationSchema } from "@helium/core/operations/observation.js";
import {
  classifyProcess,
  processProbe,
  type CommandResult,
  type CommandRunner,
} from "./process.js";

const NOW = new Date("2026-08-29T12:00:00.000Z");

const result = (over: Partial<CommandResult> = {}): CommandResult => ({
  stdout: "",
  exitCode: 0,
  timedOut: false,
  evidenceRef: "artifact://raw-command/process-fixture",
  ...over,
});

/** Records the exact argv it was handed, so the test can assert on it. */
function recordingRunner(reply: CommandResult): CommandRunner & {
  calls: { argv: readonly string[]; timeoutMs: number }[];
} {
  const calls: { argv: readonly string[]; timeoutMs: number }[] = [];
  return {
    calls,
    async run(argv, timeoutMs) {
      calls.push({ argv, timeoutMs });
      return reply;
    },
  };
}

describe("classifyProcess", () => {
  it("reports ok when the match appears in the output", () => {
    expect(classifyProcess(result({ stdout: "501 900 1 helium-opsd" }), "helium-opsd")).toBe(
      "ok",
    );
  });

  it("reports failed when the command ran cleanly and the match is absent", () => {
    expect(classifyProcess(result({ stdout: "501 900 1 launchd" }), "helium-opsd")).toBe(
      "failed",
    );
  });

  it("reports unknown on timeout, NOT failed", () => {
    // A probe that could not run has not proven the process absent. Reporting
    // `failed` here is how a timeout becomes a spurious recovery action.
    expect(
      classifyProcess(result({ timedOut: true, stdout: "" }), "helium-opsd"),
    ).toBe("unknown");
  });

  it("reports unknown on a non-zero exit, NOT failed", () => {
    expect(classifyProcess(result({ exitCode: 1, stdout: "" }), "helium-opsd")).toBe(
      "unknown",
    );
  });

  it("reports unknown on timeout even if the output already matched", () => {
    // Partial output from a killed command is not a complete reading.
    expect(
      classifyProcess(result({ timedOut: true, stdout: "helium-opsd" }), "helium-opsd"),
    ).toBe("unknown");
  });
});

describe("processProbe", () => {
  const options = {
    componentId: "helium",
    argv: ["/bin/ps", "-Ao", "pid,comm"] as const,
    match: "helium-opsd",
  };

  it("passes the EXACT argv through — nothing here builds a command string", () => {
    const runner = recordingRunner(result({ stdout: "helium-opsd" }));
    const probe = processProbe(options);
    return probe.observe(runner, NOW).then(() => {
      expect(runner.calls).toEqual([
        { argv: ["/bin/ps", "-Ao", "pid,comm"], timeoutMs: 10_000 },
      ]);
    });
  });

  it("emits an observation that satisfies the core contract", async () => {
    const probe = processProbe(options);
    const observation = await probe.observe(
      recordingRunner(result({ stdout: "helium-opsd" })),
      NOW,
    );
    expect(ObservationSchema.safeParse(observation).success).toBe(true);
    expect(observation.state).toBe("ok");
    expect(observation.dimension).toBe("readiness");
    expect(observation.parserVersion).toBe("process-liveness/1");
  });

  it("carries an expiry strictly after the reading", async () => {
    const probe = processProbe(options);
    const observation = await probe.observe(recordingRunner(result()), NOW, 60_000);
    expect(observation.observedAt).toBe("2026-08-29T12:00:00.000Z");
    expect(observation.expiresAt).toBe("2026-08-29T12:01:00.000Z");
  });

  it("carries the raw reading in value without branching on it", async () => {
    const probe = processProbe(options);
    const observation = await probe.observe(
      recordingRunner(result({ timedOut: true })),
      NOW,
    );
    expect(observation.state).toBe("unknown");
    expect(observation.value).toEqual({ matched: false, timedOut: true });
  });

  it("preserves the runner's persisted raw-command reference", async () => {
    const observation = await processProbe(options).observe(
      recordingRunner(result({ evidenceRef: "artifact://raw-command/process-42" })),
      NOW,
    );
    expect(observation.evidenceRefs).toEqual(["artifact://raw-command/process-42"]);
  });

  it("honours an explicit probe id and timeout", async () => {
    const runner = recordingRunner(result());
    const probe = processProbe({
      ...options,
      probeId: "helium.custom-liveness.v2",
      timeoutMs: 2_000,
    });
    expect(probe.probeId).toBe("helium.custom-liveness.v2");
    await probe.observe(runner, NOW);
    expect(runner.calls[0]?.timeoutMs).toBe(2_000);
  });
});
