/**
 * The mint half of the loop: turn every declared experiment into one
 * commitment, deterministically, with no model in the path.
 *
 * An experiment is a FILE (`experiments/<id>.json`), not a prompt and not a
 * row an agent writes: the hypothesis and the acceptance thresholds have to be
 * fixed before any result exists, and a file in git is the cheapest thing that
 * makes an edit to them visible in a diff.
 * @module dsh-plugin-tenant-helium-self/render
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readLedger,
  type CommitmentDraft,
  type RenderedReport,
  type RunReport,
  type TenantSpec,
} from "@helium/core";

/** Compiled to `lib/render/index.js` — two levels up — but vitest imports the
 *  TypeScript at `render/index.ts`, one level up. Probing for `tenant.yaml`
 *  costs one `existsSync` and removes the whole class of bug where a test
 *  passes against a directory the deployed build never reads. */
const HERE = dirname(fileURLToPath(import.meta.url));
const TENANT_DIR = existsSync(join(HERE, "..", "tenant.yaml"))
  ? resolve(HERE, "..")
  : resolve(HERE, "..", "..");

/**
 * The one word this tenant's settler and this renderer agree on. It travels in
 * the payload so a settler handed an older commitment can tell what kind of
 * promise it is looking at without consulting any file that may have changed.
 */
export const EXPERIMENT_KIND = "argon-sweep-compare";

/** Same resolution as the CLI (`packages/cli/src/cli.ts:35`), the markdown
 *  channel and `option-wizard/quality/prior.ts`. A renderer is handed the
 *  report and the spec and neither carries the state root, so reading it from
 *  the environment is what keeps the dedup below out of `packages/core`. */
export function stateRootOf(env: NodeJS.ProcessEnv = process.env): string {
  return env.HELIUM_STATE_ROOT ?? resolve(process.cwd(), ".helium-state");
}

export interface Experiment {
  id: string;
  [key: string]: unknown;
}

/** Every `experiments/*.json`, by file name order so two runs mint in the same
 *  order. A file that is not JSON, or whose `id` does not match its name, is a
 *  declaration nobody can settle — it throws, and a renderer that throws is a
 *  recorded skip rather than a silent half-mint. */
export function loadExperiments(dir = join(TENANT_DIR, "experiments")): Experiment[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b, "en"))
    .map((name) => {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, name), "utf8"));
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        typeof (parsed as Experiment).id !== "string"
      )
        throw new Error(`experiments/${name}: no string id`);
      const experiment = parsed as Experiment;
      if (`${experiment.id}.json` !== name)
        throw new Error(`experiments/${name}: id ${experiment.id} != file name`);
      return experiment;
    });
}

/**
 * Why this skips ids the ledger already holds, rather than letting the runner
 * do it: `outstanding()` already de-duplicates by id (it keeps the FIRST record
 * per id), so a re-mint could never create a second outstanding promise or a
 * second scoreboard row — the dedup here is only to keep the jsonl from growing
 * one identical line per run for a promise that settles months later. That is a
 * tenant's housekeeping, not a core concern, so it costs zero edits to
 * `packages/core` (doctrine 2) and one read of a file the tenant already owns.
 */
export function commitmentDrafts(
  experiments: readonly Experiment[],
  minted: ReadonlySet<string>,
): CommitmentDraft[] {
  return experiments
    .filter((experiment) => !minted.has(experiment.id))
    .map((experiment) => ({
      id: experiment.id,
      payload: { ...experiment, kind: EXPERIMENT_KIND },
    }));
}

export default function render(
  report: RunReport,
  spec: TenantSpec,
): RenderedReport {
  const experiments = loadExperiments();
  const ledger = readLedger(stateRootOf(), spec.tenant);
  const minted = new Set(ledger.commitments.map((entry) => entry.id));
  const drafts = commitmentDrafts(experiments, minted);

  const lines = [
    `# helium-self — ${report.day}`,
    "",
    `${String(experiments.length)} experiment(s) declared, ${String(drafts.length)} minted this run.`,
    "",
  ];
  for (const experiment of experiments) {
    lines.push(
      `## ${experiment.id}${minted.has(experiment.id) ? " (already outstanding)" : ""}`,
      "",
      `- repo: ${String(experiment.repo ?? "unknown")}`,
      `- change: ${String(experiment.change ?? "unstated")}`,
      `- hypothesis: ${String(experiment.hypothesis ?? "unstated")}`,
      `- rule: ${String(experiment.rule ?? "unstated")}`,
      "",
    );
  }
  for (const step of report.steps)
    lines.push(`## ${step.task} — ${step.role}`, "", step.text, "");

  return {
    text: lines.join("\n"),
    data: { experiments, minted: drafts.map((draft) => draft.id) },
    commitments: drafts,
  };
}
