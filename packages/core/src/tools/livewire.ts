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
 * DuckDB's core table functions -- read_csv, read_parquet, read_json,
 * read_text, read_ndjson, glob -- read arbitrary local files from inside a
 * SELECT even on a READ_ONLY connection (verified against the installed
 * @duckdb/node-api); ATTACH opens a second database file outright; COPY
 * exports query results to disk; INSTALL and LOAD can pull in an extension
 * that reintroduces write or network access. livewire lake access is via
 * catalog views, so agent SQL never legitimately needs any of these -- deny
 * them as a third layer, alongside isSelectOnly and DuckDB's own READ_ONLY
 * connection.
 *
 * Matched as a PREFIX (`\w*` after the alternation, no trailing `\b`), not
 * an exact word: DuckDB ships underscore-suffixed variants of several of
 * these -- read_csv_auto, read_json_auto, ... -- that are real, still-
 * supported functions with the same filesystem-read problem as their
 * unsuffixed form. `\b` alone does not treat "_" as a boundary, so
 * `\bread_csv\b` does NOT match inside "read_csv_auto" (fix round 1: this
 * was a live bypass, `SELECT * FROM read_csv_auto(...)` passed). The
 * tradeoff this widens: a legitimate identifier that happens to literally
 * start with one of these tokens (e.g. a column named "attachment_id") is
 * now also denied -- accepted per the same "erring toward rejection" v1
 * tradeoff already applied to the exact-word tokens below.
 */
const DENIED_TOKENS =
  /\b(read_csv|read_parquet|read_json|read_text|read_ndjson|glob|install|load|attach|copy)\w*/i;

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
        "read_json, read_text, read_ndjson, glob, and their _auto/etc. variants), " +
        "database/extension management (attach, install, load), and exporting results to " +
        "disk (copy) are refused.",
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
            "livewire_sql refuses read_csv/read_parquet/read_json/read_text/read_ndjson/glob " +
              "(including _auto/etc. variants)/attach/install/load/copy: read through the " +
              "lake's catalog views, not raw file paths",
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
