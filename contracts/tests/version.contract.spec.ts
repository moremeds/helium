import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { dshBin, dshVersion } from "../src/dsh.js";

describe("contract: dsh installation identity", () => {
  it("runs the version this suite claims to cover", () => {
    const printed = execFileSync(dshBin, ["--version"], {
      encoding: "utf8",
    }).trim();
    expect(printed).toBe(dshVersion);
  });
});
