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

function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/** Strip comments, then require a single SELECT/WITH statement. DuckDB READ_ONLY is layer two. */
export function isSelectOnly(sql: string): boolean {
  const bare = stripSqlComments(sql).trim();
  const withoutTrailing = bare.replace(/;\s*$/, "");
  if (withoutTrailing.includes(";")) return false;
  return /^(select|with)\b/i.test(withoutTrailing);
}

/**
 * DuckDB's core table functions -- read_csv, read_parquet, read_json, glob
 * -- read arbitrary local files from inside a SELECT even on a READ_ONLY
 * connection (verified against the installed @duckdb/node-api); INSTALL and
 * LOAD can pull in an extension that reintroduces write or network access.
 * livewire lake access is via catalog views, so agent SQL never legitimately
 * needs any of these -- deny them as a third layer, alongside isSelectOnly
 * and DuckDB's own READ_ONLY connection.
 */
const DENIED_TOKENS =
  /\b(read_csv|read_parquet|read_json|glob|install|load)\b/i;

export function hasDeniedTableFunction(sql: string): boolean {
  return DENIED_TOKENS.test(stripSqlComments(sql));
}

export function livewireTools(livewireDb: string | undefined): EcosystemTool[] {
  if (!livewireDb) return [];
  return [
    {
      name: "livewire_sql",
      description:
        "Run one read-only SELECT (or WITH ... SELECT) against livewire's DuckDB lake, " +
        "through its catalog views only. The connection is opened READ_ONLY; writes are " +
        "refused by the engine. Raw file-reading table functions (read_csv, read_parquet, " +
        "read_json, glob) and extension management (install, load) are refused.",
      paramsSchema: Params,
      mutating: false,
      async run(args) {
        const { sql, maxRows } = Params.parse(args);
        if (!isSelectOnly(sql)) {
          throw new Error(
            "livewire_sql accepts a single SELECT or WITH statement only",
          );
        }
        if (hasDeniedTableFunction(sql)) {
          throw new Error(
            "livewire_sql refuses read_csv/read_parquet/read_json/glob/install/load: " +
              "read through the lake's catalog views, not raw file paths",
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
