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
  return root;
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
