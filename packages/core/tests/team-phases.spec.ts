import { describe, expect, it } from "vitest";
import { parseTeamYaml } from "../src/team.js";

const HEAD = `manifestVersion: "2"
name: demo
roles:
  prober:
    requires: [tool.use]
    permissions: { tools: [echo] }
tasks:
`;

describe("team task phases", () => {
  it("accepts a task with no phases and a task with phases", () => {
    const manifest = parseTeamYaml(
      `${HEAD}  - id: always
    role: prober
    requires: [tool.use]
  - id: sometimes
    role: prober
    requires: [tool.use]
    phases: [premarket, close]
`,
    );
    expect(manifest.tasks[0]!.phases).toBeUndefined();
    expect(manifest.tasks[1]!.phases).toEqual(["premarket", "close"]);
  });

  it("rejects an empty phases array", () => {
    expect(() =>
      parseTeamYaml(
        `${HEAD}  - id: broken
    role: prober
    requires: [tool.use]
    phases: []
`,
      ),
    ).toThrow();
  });
});
