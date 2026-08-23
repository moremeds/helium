import { createHash } from "node:crypto";
import {
  nowIso,
  type StateStore,
  type Trigger,
  type TriggerStateChange,
} from "@helium/core";

export interface TriggerEvent {
  job: string;
  kind: Trigger["kind"];
  firedAt: string;
  dedupKey: string;
  payload: Record<string, unknown>;
}

/**
 * Resolve each dot-path against `body`. A path that does not resolve yields `null`
 * (never `undefined`) so JSON.stringify keeps the key and the hash stays stable.
 */
export function extractFields(
  body: unknown,
  fields: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const path of fields) {
    let cursor: unknown = body;
    for (const segment of path.split(".")) {
      if (cursor === null || typeof cursor !== "object") {
        cursor = undefined;
        break;
      }
      cursor = (cursor as Record<string, unknown>)[segment];
    }
    out[path] = cursor === undefined ? null : cursor;
  }
  return out;
}

/** sha256 over the key-sorted JSON projection, truncated to 12 hex chars. */
export function hashFields(x: Record<string, unknown>): string {
  const sorted = Object.keys(x)
    .sort()
    .map((k) => [k, x[k]] as const);
  return createHash("sha256")
    .update(JSON.stringify(sorted))
    .digest("hex")
    .slice(0, 12);
}
