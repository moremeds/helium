import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// plutil -lint accepts plists launchd then rejects, so this parses with
// plistlib — the same parser the loader effectively is — and asserts the keys
// that actually decide whether the job runs.
//
// StartCalendarInterval is in the machine's LOCAL zone and the mini's zone is
// Asia/Hong_Kong, so these are HKT numbers; there is no zone key in the plist
// format to write, which is why the named zone lives in tenant.yaml instead.
const PHASES = {
  premarket: { Hour: 20, Minute: 45 },
  frank: { Hour: 21, Minute: 0, Weekday: 1 },
  intraday: { Hour: 1, Minute: 0 },
  close: { Hour: 4, Minute: 15 },
  weekly: { Hour: 20, Minute: 0, Weekday: 0 },
} as const;

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

describe("launchd option-wizard plists", () => {
  for (const [phase, calendar] of Object.entries(PHASES)) {
    it(`${phase} plist parses and schedules ${JSON.stringify(calendar)}`, () => {
      const path = `${repoRoot}launchd/com.helium.option-wizard-${phase}.plist`;
      const json = execFileSync("python3", [
        "-c",
        "import plistlib,sys,json; print(json.dumps(plistlib.load(open(sys.argv[1],'rb'))))",
        path,
      ]).toString();
      const plist = JSON.parse(json);
      expect(plist.Label).toBe(`com.helium.option-wizard-${phase}`);
      expect(plist.StartCalendarInterval).toEqual(calendar);
      expect(plist.ProgramArguments.slice(0, 1)).toEqual(["/bin/zsh"]);
      expect(plist.ProgramArguments.at(-1)).toBe(phase);
      expect(plist.RunAtLoad).toBe(false);
    });
  }
});
