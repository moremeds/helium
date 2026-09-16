import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { writeRecording, sha256 } from "../src/tool-io.js";
import { loadSnapshotRecordings } from "../src/replay-strict.js";

it("replays repeated queries and errors in order and refuses missing/corrupted input", () => {
  const dir = mkdtempSync(join(tmpdir(), "helium-strict-replay-"));
  for (const [i, raw] of ["first", null, "third"].entries())
    writeRecording(dir, i + 1, { tool: "source", args: {}, at: "2026-09-11T00:00:00Z",
      raw, rawSha256: raw === null ? null : sha256(raw), rawBytes: raw?.length ?? 0,
      context: null, ...(raw === null ? { error: "recorded outage" } : {}) });
  const replay = loadSnapshotRecordings(dir);
  expect(replay.lookup("source", {})).toBe("first");
  expect(() => replay.lookup("source", {})).toThrow("recorded outage");
  expect(replay.lookup("source", {})).toBe("third");
  expect(() => replay.lookup("source", {})).toThrow("NOT_COMPARABLE");
  expect(replay.issues()).toHaveLength(1);
  writeRecording(dir, 4, { tool: "source", args: {}, at: "2026-09-11T00:00:00Z",
    raw: "tampered", rawSha256: sha256("original"), rawBytes: 8, context: null });
  expect(() => loadSnapshotRecordings(dir)).toThrow("corrupted");
});
