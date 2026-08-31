import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parseShepherdctlArgs, runShepherdctl } from "./shepherdctl.js";

describe("shepherdctl", () => {
  it("accepts only one absolute private config", () => {
    expect(parseShepherdctlArgs(["check-config", "--config", "/private/shepherd.json"]))
      .toEqual({ command: "check-config", configPath: "/private/shepherd.json" });
    expect(() => parseShepherdctlArgs(["tick", "--config", "relative.json"]))
      .toThrow(/absolute/);
    expect(() => parseShepherdctlArgs(["shell", "--config", "/tmp/x"]))
      .toThrow(/usage/);
  });

  it("validates without starting and runs exactly one requested tick", async () => {
    const root = mkdtempSync(join(tmpdir(), "shepherdctl-"));
    const configPath = join(root, "config.json");
    writeFileSync(configPath, "{}", { mode: 0o600 });
    chmodSync(configPath, 0o600);
    const load = vi.fn(() => ({ version: 1 } as never));
    const tickOnce = vi.fn(async () => ({ cycleId: "cycle-1" }));
    const compose = vi.fn(() => ({ tickOnce }) as never);

    await expect(runShepherdctl(["check-config", "--config", configPath], { load, compose }))
      .resolves.toEqual({ ok: true, command: "check-config" });
    expect(compose).not.toHaveBeenCalled();

    await expect(runShepherdctl(["tick", "--config", configPath], { load, compose }))
      .resolves.toEqual({ ok: true, command: "tick", result: { cycleId: "cycle-1" } });
    expect(tickOnce).toHaveBeenCalledOnce();
  });

  it("refuses a group-readable config before parsing it", async () => {
    const root = mkdtempSync(join(tmpdir(), "shepherdctl-public-"));
    const configPath = join(root, "config.json");
    writeFileSync(configPath, "{}", { mode: 0o644 });
    chmodSync(configPath, 0o644);
    const load = vi.fn();

    await expect(runShepherdctl(["check-config", "--config", configPath], {
      load,
      compose: vi.fn(),
    })).rejects.toThrow(/owner-only/);
    expect(load).not.toHaveBeenCalled();
  });
});
