import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const helper = new URL("./validate-tenants.mjs", import.meta.url).pathname;

function release() {
  const root = mkdtempSync(join(tmpdir(), "helium-release-tenants-"));
  mkdirSync(join(root, "plugins/helium/lib"), { recursive: true });
  mkdirSync(join(root, "plugins/alpha"), { recursive: true });
  writeFileSync(
    join(root, "plugins/helium/package.json"),
    JSON.stringify({ type: "module" }),
  );
  inventory(root, []);
  return root;
}

/** Stub the host's own enabled/disabled inventory for this release. */
function inventory(root, entries) {
  writeFileSync(
    join(root, "plugins/helium/lib/tenants.js"),
    `export function inventoryTenantPlugins() { return ${JSON.stringify(entries)}; }`,
  );
}

test("validates a clean release through the host tenant loader", () => {
  const root = release();
  writeFileSync(
    join(root, "plugins/helium/lib/tenant-runtime.js"),
    `export async function loadValidatedTenants({ tenantsDir: directory }) {
      if (!directory.endsWith("/plugins")) throw new Error("wrong tenants directory");
      return { tenants: [{ spec: { tenant: "alpha" } }], skipped: [] };
    }`,
  );
  const output = execFileSync(process.execPath, [helper, root], {
    encoding: "utf8",
  });
  assert.match(output, /1 tenant file\(s\) parse cleanly: alpha/);
});

test("fails the release when any tenant is skipped", () => {
  const root = release();
  writeFileSync(
    join(root, "plugins/helium/lib/tenant-runtime.js"),
    `export async function loadValidatedTenants() {
      return { tenants: [], skipped: [{ tenant: "alpha", reason: "bad team.yaml" }] };
    }`,
  );
  assert.throws(() =>
    execFileSync(process.execPath, [helper, root], { stdio: "pipe" }),
  );
});

test("does not fail the release for a tenant that ships disabled", () => {
  // plugins/livewire-shepherd ships `enabled: false` with team manifests naming
  // tools no tenant provides yet. It cannot run, so it is not a deploy hazard --
  // but failing on it would make shipping any disabled tenant impossible.
  const root = release();
  inventory(root, [{ tenant: "shepherd", load: "disabled" }]);
  writeFileSync(
    join(root, "plugins/helium/lib/tenant-runtime.js"),
    `export async function loadValidatedTenants() {
      return { tenants: [], skipped: [{ tenant: "shepherd", reason: "unknown tools: a, b" }] };
    }`,
  );
  const output = execFileSync(process.execPath, [helper, root], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.match(output, /0 tenant file\(s\) parse cleanly/);
});

test("still fails the release for an ENABLED tenant that is skipped", () => {
  const root = release();
  inventory(root, [
    { tenant: "shepherd", load: "disabled" },
    { tenant: "alpha", load: "loaded" },
  ]);
  writeFileSync(
    join(root, "plugins/helium/lib/tenant-runtime.js"),
    `export async function loadValidatedTenants() {
      return { tenants: [], skipped: [
        { tenant: "shepherd", reason: "unknown tools: a, b" },
        { tenant: "alpha", reason: "unknown tools: c" },
      ] };
    }`,
  );
  assert.throws(
    () => execFileSync(process.execPath, [helper, root], { stdio: "pipe" }),
    /1 enabled tenant\(s\) failed validation/,
  );
});

test("an unparseable manifest is `invalid`, never `disabled`, so it blocks", () => {
  const root = release();
  inventory(root, [{ tenant: "broken", load: "invalid" }]);
  writeFileSync(
    join(root, "plugins/helium/lib/tenant-runtime.js"),
    `export async function loadValidatedTenants() {
      return { tenants: [], skipped: [{ tenant: "broken", reason: "invalid tenant.yaml" }] };
    }`,
  );
  assert.throws(
    () => execFileSync(process.execPath, [helper, root], { stdio: "pipe" }),
    /1 enabled tenant\(s\) failed validation/,
  );
});
