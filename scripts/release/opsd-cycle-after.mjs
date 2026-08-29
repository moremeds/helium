#!/usr/bin/env node
/** Fail-closed target-release controller-cycle gate for deploy and rollback. */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function hasTargetCycle(text, sinceSeconds, target, nowMs = Date.now()) {
  const sinceMs = Number(sinceSeconds) * 1000;
  if (!Number.isFinite(sinceMs) || !Number.isFinite(nowMs)) return false;
  return text.split("\n").filter(Boolean).some((line) => {
    try {
      const event = JSON.parse(line)?.record;
      const at = Date.parse(event?.at);
      return event?.type === "controller-cycle-recorded" &&
        event.releaseRef === target && Number.isFinite(at) &&
        at > sinceMs && at <= nowMs && event.observationCount > 0;
    } catch {
      return false;
    }
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [path, since, target, injectedNow] = process.argv.slice(2);
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    // A missing log has no qualifying cycle.
  }
  const now = injectedNow === undefined ? Date.now() : Number(injectedNow);
  process.stdout.write(hasTargetCycle(text, since, target, now) ? "1" : "0");
}
