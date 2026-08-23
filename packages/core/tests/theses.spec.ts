import { mkdtempSync, readFileSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ThesisStore } from "../src/theses.js";

const store = () =>
  new ThesisStore(mkdtempSync(join(tmpdir(), "helium-thesis-")));

describe("ThesisStore", () => {
  it("returns null before the first write", () => {
    expect(store().read("macro-watch")).toBeNull();
  });

  it("versions each write, re-points current, and diffs against the previous version", () => {
    const s = store();
    const first = s.write("macro-watch", "Rate path: two cuts by year end.\n");
    expect(first.diff).toContain("+Rate path: two cuts by year end.");
    expect(s.read("macro-watch")).toBe("Rate path: two cuts by year end.\n");

    const second = s.write("macro-watch", "Rate path: one cut by year end.\n");
    expect(second.path).not.toBe(first.path);
    expect(second.diff).toContain("-Rate path: two cuts by year end.");
    expect(second.diff).toContain("+Rate path: one cut by year end.");
    expect(s.read("macro-watch")).toBe("Rate path: one cut by year end.\n");
    expect(readlinkSync(join(s.dir("macro-watch"), "current"))).toBe(
      second.path.split("/").at(-1),
    );
    expect(readFileSync(first.path, "utf8")).toBe(
      "Rate path: two cuts by year end.\n",
    );
  });

  it("rejects a rewrite larger than 64 KiB", () => {
    expect(() => store().write("macro-watch", "x".repeat(65_537))).toThrow(
      /64 ?KiB|65536/,
    );
  });
});
