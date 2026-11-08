/**
 * position-review tools. One tool, `pr_book`: a read-only broker snapshot
 * (IB TWS API + Futu OpenD, via broker/snapshot.py) plus every derived figure
 * the report prints. Raw inputs and the analysis are written to the state root
 * BEFORE the tool returns, so the run's evidence is durable even if the model
 * step fails.
 *
 * Private tenant: this output must never reach a public surface (argon). Its
 * delivery is markdown + email only — see tenant.yaml.
 * @module position-review/tools
 */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ToolVocabularyEntry } from "@helium/core";
import { analyse } from "./analyse.js";

export const VOCABULARY: ReadonlyMap<string, ToolVocabularyEntry> = new Map([
  ["pr_book", { mutating: false }],
]);

// lib/tools/index.js -> ../../broker/snapshot.py (broker/ is shipped as source)
const SNAPSHOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../broker/snapshot.py");

function writePrivate(path: string, body: string): void {
  writeFileSync(path, body);
  chmodSync(path, 0o600);
}

export function buildTools(cfg: { stateRoot: string; env: Record<string, string | undefined> }) {
  const env = cfg.env;
  return [
    {
      name: "pr_book",
      description:
        "Read-only snapshot of the IB and Futu books (positions, account, ALL open orders) plus SPX/ES/underlying bars, and every derived figure: spread credit/mark/breakeven, SPX stop candidates with estimated loss at each (flat IV and IV+5), the SPX level where the IB cushion reaches 0, per-underlying stop and take-profit candidates with estimated P&L, and stop/take-profit order coverage. Copy figures verbatim; never compute.",
      paramsSchema: z.object({}),
      mutating: false,
      dshParams: {},
      async run(): Promise<string> {
        const python = env.PR_PYTHON;
        if (!python) throw new Error("pr_book: PR_PYTHON is not set (a python with ib_async + futu-api)");
        const child = spawnSync(python, ["-I", SNAPSHOT], {
          encoding: "utf8",
          timeout: 420_000,
          maxBuffer: 64 * 1024 * 1024,
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            // futu-api writes its log/config under $HOME and raises KeyError without it.
            HOME: process.env.HOME ?? "",
            ...Object.fromEntries(
              Object.entries(env).filter(([k, v]) => k.startsWith("PR_") && v !== undefined),
            ),
          },
        });
        if (child.status !== 0)
          throw new Error(`pr_book: snapshot exited ${String(child.status)}: ${(child.stderr ?? "").slice(-500)}`);
        const raw = JSON.parse(child.stdout.trim().split("\n").at(-1)!) as Record<string, unknown>;
        const asOf = new Date();
        const dir = join(cfg.stateRoot, "position-review", asOf.toISOString().replace(/[:.]/g, "-"));
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writePrivate(join(dir, "inputs.json"), JSON.stringify(raw));
        const analysis = { ...analyse(raw, asOf), evidenceDir: dir };
        writePrivate(join(dir, "analysis.json"), JSON.stringify(analysis, null, 1));
        return JSON.stringify(analysis);
      },
    },
  ];
}
