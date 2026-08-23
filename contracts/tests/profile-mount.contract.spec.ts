import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deployHeliumProfile, dshBin, makeDshHome } from "../src/dsh.js";

describe("contract: the helium profile mounts in an isolated $DSH_HOME", () => {
  let dshHome: string;

  beforeAll(() => {
    dshHome = makeDshHome();
    deployHeliumProfile(dshHome);
  });

  afterAll(() => {
    rmSync(dshHome, { recursive: true, force: true });
  });

  it("composes the tree with the helium row in it", () => {
    const dump = execFileSync(
      dshBin,
      ["--profile", "helium", "--dump-config"],
      {
        env: { ...process.env, DSH_HOME: dshHome },
        encoding: "utf8",
      },
    );
    expect(dump).toContain("dsh-plugin-helium");
    expect(dump).toContain("helium");
  });
});
