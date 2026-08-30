import { describe, expect, it, vi } from "vitest";
import { ShadowAdapter } from "./shadow.js";

const job = { name: "macro", prompt: "analyze" } as never;
const event = {
  job: "macro",
  kind: "cron",
  firedAt: "2026-08-30T00:00:00.000Z",
  dedupKey: "macro:one",
  payload: { n: 1 },
} as never;

describe("ShadowAdapter", () => {
  it("always preserves the v1 path and adds only a shadow run", async () => {
    const v1 = vi.fn();
    const run = vi.fn(async () => ({ state: "completed" as const }));
    const shadow = new ShadowAdapter({ enabled: true, run });
    await shadow.handle(job, event, v1);
    expect(v1).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
  });

  it("defaults to v1-only behavior when disabled", async () => {
    const v1 = vi.fn();
    const run = vi.fn();
    await new ShadowAdapter({ enabled: false, run }).handle(job, event, v1);
    expect(v1).toHaveBeenCalledOnce();
    expect(run).not.toHaveBeenCalled();
  });
});
