import type { ComponentSpec } from "@helium/core/operations/component.js";
import { canMutate } from "@helium/core/operations/mutation-owner.js";
import { describe, expect, it } from "vitest";
import {
  launchdControllerProbe,
  parseLoadedLabels,
} from "./launchd-controller.js";
import { fakeLaunchctl, sequencedLaunchctl } from "../testing/fake-launchctl.js";

const OWN = "com.helium.opsd";
const OTHER = "com.local.colima-watchdog";

const component = (
  owner: "opsd" | "external" | "none" = "opsd",
  competingLabels: string[] = [OTHER],
): ComponentSpec => ({
  version: 1,
  id: "runtime",
  kind: "container-runtime",
  mutationOwner: {
    owner,
    competingLabels,
    changedAt: "2026-08-25T00:00:00.000Z",
    changeRef: "artifact://ownership/1",
  },
});

const now = new Date("2026-08-25T04:00:00.000Z");

describe("launchdControllerProbe", () => {
  it("reports clear when only our own controller is loaded", async () => {
    const probe = launchdControllerProbe({ launchctl: fakeLaunchctl([OWN]) });
    expect(await probe.check(component())).toMatchObject({ result: "clear" });
  });

  it("reports competing when a declared rival controller is loaded", async () => {
    const probe = launchdControllerProbe({
      launchctl: fakeLaunchctl([OWN, OTHER]),
    });
    const outcome = await probe.check(component());
    expect(outcome).toMatchObject({ result: "competing" });
    expect(await canMutate(component(), outcome)).toEqual({
      ok: false,
      reason: "competing-controller",
    });
  });

  it("enumerates with exact argv and never a constructed string", async () => {
    const launchctl = fakeLaunchctl([OWN]);
    await launchdControllerProbe({ launchctl }).check(component());
    expect(launchctl.calls).toEqual([["list"]]);
  });

  it("keeps the persisted raw evidence ref on the exact mutation-time check", async () => {
    const outcome = await launchdControllerProbe({
      launchctl: fakeLaunchctl([OWN]),
    }).check(component());
    expect(outcome.evidenceRef).toBe("artifact://raw-command/fake-launchctl");
    expect(await canMutate(component(), outcome)).toEqual({ ok: true });
  });

  it.each([
    ["a non-zero exit", { exitCode: 1 }, "enumeration-exit-1"],
    ["a timeout", { timedOut: true }, "enumeration-timeout"],
    ["truncated output", { stdout: `PID\tStatus\tLabel\n-\t0\t${OWN}`, truncated: true }, "enumeration-truncated"],
    ["unparseable output", { stdout: "this is not a table" }, "enumeration-unparseable"],
  ])("yields unknown, and therefore refusal, on %s", async (_label, script, detail) => {
    const probe = launchdControllerProbe({ launchctl: fakeLaunchctl(script) });
    const outcome = await probe.check(component());
    expect(outcome).toMatchObject({ result: "unknown", detail });
    expect(await canMutate(component(), outcome)).toEqual({
      ok: false,
      reason: "ownership-unverifiable",
    });
  });

  it("ignores a loaded label the component never declared as competing", async () => {
    const probe = launchdControllerProbe({
      launchctl: fakeLaunchctl([OWN, "com.apple.something.unrelated"]),
    });
    expect(await probe.check(component())).toMatchObject({ result: "clear" });
  });

  // The window that matters is between the check and the exec. A rival that
  // appears in it must be caught by re-checking at spawn time, not assumed
  // away because the earlier probe was clear.
  it("catches a rival that appears between the first check and the re-check", async () => {
    const probe = launchdControllerProbe({
      launchctl: sequencedLaunchctl([[OWN], [OWN, OTHER]]),
    });
    expect(await probe.check(component())).toMatchObject({ result: "clear" });
    const atSpawn = await probe.check(component());
    expect(atSpawn).toMatchObject({ result: "competing" });
    expect(await canMutate(component(), atSpawn)).toMatchObject({ ok: false });
  });

  it("refuses regardless of the probe when another controller owns the component", async () => {
    const probe = launchdControllerProbe({ launchctl: fakeLaunchctl([OWN]) });
    const outcome = await probe.check(component("external"));
    expect(outcome.result).toBe("clear");
    expect(await canMutate(component("external"), outcome)).toEqual({
      ok: false,
      reason: "external-owner",
    });
  });
});

describe("observations", () => {
  it("emits a controller-dimension observation carrying the raw labels", async () => {
    const probe = launchdControllerProbe({ launchctl: fakeLaunchctl([OWN, OTHER]) });
    const observation = await probe.observe(component(), now);
    expect(observation).toMatchObject({
      componentId: "runtime",
      dimension: "controller",
      state: "failed",
      parserVersion: "controller-enumeration/1",
    });
    expect(observation.value).toMatchObject({ controllerResult: "competing" });
    expect(observation.evidenceRefs).toEqual([
      "artifact://raw-command/fake-launchctl",
    ]);
    expect(observation.expiresAt > observation.observedAt).toBe(true);
  });

  // `competing` is a real fault; `unknown` is absence of proof. Collapsing
  // them would make an unverifiable host look like a healthy one.
  it("distinguishes an unverifiable enumeration from a clean one", async () => {
    const unknown = await launchdControllerProbe({
      launchctl: fakeLaunchctl({ exitCode: 1 }),
    }).observe(component(), now);
    expect(unknown.state).toBe("unknown");

    const clear = await launchdControllerProbe({
      launchctl: fakeLaunchctl([OWN]),
    }).observe(component(), now);
    expect(clear.state).toBe("ok");
  });
});

describe("parseLoadedLabels", () => {
  it("reads a header-led table", () => {
    expect(parseLoadedLabels(`PID\tStatus\tLabel\n1\t0\t${OWN}`)).toEqual([OWN]);
  });

  it("reads a table with no header", () => {
    expect(parseLoadedLabels(`1\t0\t${OWN}`)).toEqual([OWN]);
  });

  it("reports empty output as no labels", () => {
    expect(parseLoadedLabels("")).toEqual([]);
  });

  // A label this parser skipped is exactly the competing controller it exists
  // to find, so a partially readable table is refused entirely.
  it("refuses the whole table when any line is malformed", () => {
    expect(parseLoadedLabels(`1\t0\t${OWN}\ngarbage`)).toBeUndefined();
    expect(parseLoadedLabels(`1\t0\t${OWN}\n1\t0\t`)).toBeUndefined();
  });
});
