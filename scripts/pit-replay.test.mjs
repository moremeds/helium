import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("capture uses the existing source overlay and preserves an explicit read route", () => {
  const dir = mkdtempSync(join(tmpdir(), "helium-capture-env-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "node"), '#!/bin/sh\nprintf "%s\\n" "$OW_ARGON_API_BASE" "$HELIUM_TENANT_DELIVERY" "$@"\n', { mode: 0o700 });
  writeFileSync(join(dir, "helium.env"), "HELIUM_TENANT_DELIVERY=1\n");
  writeFileSync(join(dir, "argon.env"), "ARGON_BASE_URL=http://example.invalid\n");
  const run = route => spawnSync("/bin/bash", [new URL("./pit-replay.sh", import.meta.url).pathname,
    "capture", "premarket", "ow_session_frame"], { encoding: "utf8", env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, PIT_TENANT: "option-wizard",
      HELIUM_ENV_FILE: join(dir, "helium.env"), HELIUM_ARGON_ENV_FILE: join(dir, "argon.env"),
      OW_ARGON_API_BASE: route,
    } });
  const inherited = run("");
  assert.equal(inherited.status, 0, inherited.stderr);
  assert.match(inherited.stdout, /^http:\/\/example\.invalid\n0\n/);
  assert.match(inherited.stdout, /runtime-capture\noption-wizard\n--phase\npremarket\n--tool\now_session_frame/);
  const explicit = run("http://explicit.invalid");
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.match(explicit.stdout, /^http:\/\/explicit\.invalid\n0\n/);
});
