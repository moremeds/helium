/**
 * What a run actually did, on disk, in one file per run.
 *
 * The audit table answers "what did it cost"; this answers "what was it
 * asked, and what did it say". Both exist because neither can be reconstructed
 * from the other, and a scoreboard that says a forecast was bad is useless
 * without the prompt that produced it.
 *
 * The whole document is REWRITTEN after every step rather than appended to. A
 * jsonl would append more cheaply, but the file is read by hand and by a
 * consumer that wants one object; at a dozen steps and ~100 KB, rewriting is
 * cheaper than the tooling that would reassemble it. The property that matters
 * — a run killed by launchd mid-way still leaves the steps it completed — is
 * the same either way.
 *
 * Tool calls are NOT recorded here. The run recorder writes raw tool responses
 * under `<stateRoot>/runs/<runId>/tool-io/`; `toolIo` names that directory and
 * this module never reads inside it.
 * @module @helium/cli/evidence
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RunReport } from "@helium/core";

export interface EvidenceHeader {
  runId: string;
  tenant: string;
  day: string;
  phase: string;
  deployment: "production" | "backtest" | "test";
  variant: string;
  asOf?: string;
  startedAt: string;
  codeSha: string;
  dshVersion: string;
  teamYamlSha256: string;
  tenantYamlSha256: string;
  /** Written by the run recorder, not by this module. */
  toolIo: string;
}

export interface EvidenceStep {
  task: string;
  role: string;
  mode: string;
  provider?: string;
  model?: string;
  /**
   * The exact string the runner handed the executor. NOT the full provider
   * request: dsh adds its own system prompt and tool specs at the edge, and
   * `dshVersion` in the header is what pins those.
   */
  assembledPrompt?: string;
  output: string;
  gateResults?: Array<{ id: string; reason: string }>;
}

export interface EvidenceDoc {
  run: EvidenceHeader;
  steps: EvidenceStep[];
  view?: unknown;
}

export function evidencePath(
  stateRoot: string,
  tenant: string,
  day: string,
  phase: string,
  runId: string,
): string {
  return join(stateRoot, "evidence", `${tenant}-${day}-${phase}-${runId}.json`);
}

export function sha256File(path: string): string {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    // A manifest that could not be read is a fact about the tree, not a reason
    // to lose the whole evidence file.
    return "";
  }
}

export class EvidenceFile {
  readonly #path: string;
  #doc: EvidenceDoc;

  constructor(path: string, header: EvidenceHeader) {
    this.#path = path;
    this.#doc = { run: header, steps: [] };
    this.#write();
  }

  /** Everything the report holds so far, plus the prompts, plus the view. */
  sync(
    report: RunReport,
    prompts: ReadonlyMap<string, string>,
    view?: unknown,
  ): void {
    this.#doc.steps = report.steps.map((step) => {
      const prompt = prompts.get(step.task);
      return {
        task: step.task,
        role: step.role,
        mode: step.mode,
        ...(step.targetId === undefined ? {} : { model: step.targetId }),
        ...(prompt === undefined ? {} : { assembledPrompt: prompt }),
        output: step.text,
        ...(step.gateRefusals === undefined
          ? {}
          : { gateResults: step.gateRefusals }),
      };
    });
    if (view !== undefined) this.#doc.view = view;
    this.#write();
  }

  read(): EvidenceDoc {
    return JSON.parse(readFileSync(this.#path, "utf8")) as EvidenceDoc;
  }

  /** Write to a sibling then rename: a kill mid-write must not truncate the
   *  file that already held every completed step. */
  #write(): void {
    mkdirSync(dirname(this.#path), { recursive: true });
    const tmp = `${this.#path}.partial`;
    writeFileSync(tmp, `${JSON.stringify(this.#doc, null, 1)}\n`, "utf8");
    renameSync(tmp, this.#path);
  }
}
