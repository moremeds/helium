/**
 * livewire (historical Parquet lake, DuckDB, local disk) read-only SQL tool.
 * @module @helium/core/tools/livewire
 */
import { DuckDBInstance } from "@duckdb/node-api";
import { z } from "zod";
import type { EcosystemTool } from "./types.js";

const Params = z.object({
  sql: z.string().min(1),
  maxRows: z.number().int().min(1).max(5_000).optional(),
});

/** Strip comments, then require a single SELECT/WITH statement. DuckDB READ_ONLY is layer two. */
export function isSelectOnly(sql: string): boolean {
  const bare = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .trim();
  const withoutTrailing = bare.replace(/;\s*$/, "");
  if (withoutTrailing.includes(";")) return false;
  return /^(select|with)\b/i.test(withoutTrailing);
}

export function livewireTools(livewireDb: string | undefined): EcosystemTool[] {
  if (!livewireDb) return [];
  return [
    {
      name: "livewire_sql",
      description:
        "Run one read-only SELECT (or WITH ... SELECT) against livewire's DuckDB lake. " +
        "The connection is opened READ_ONLY; writes are refused by the engine.",
      paramsSchema: Params,
      mutating: false,
      async run(args) {
        const { sql, maxRows } = Params.parse(args);
        if (!isSelectOnly(sql)) {
          throw new Error(
            "livewire_sql accepts a single SELECT or WITH statement only",
          );
        }
        const instance = await DuckDBInstance.create(livewireDb, {
          access_mode: "READ_ONLY",
        });
        const connection = await instance.connect();
        try {
          const reader = await connection.runAndReadAll(sql);
          const rows = reader.getRowObjectsJson().slice(0, maxRows ?? 200);
          return JSON.stringify({ rowCount: rows.length, rows });
        } finally {
          connection.closeSync();
          instance.closeSync();
        }
      },
    },
  ];
}
