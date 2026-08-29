/**
 * The STATIC half of the canonical topology guard: no sensor may reach an
 * executor, a provider adapter, a lease, or a run.
 *
 * Scheduled at Phase 1 rather than Phase 3 because both of its assertions are
 * decidable from types and the import graph -- it needs no task DAG, no
 * evidence ledger and no team controller. The behavioral half, which does need
 * an advancing DAG and an accepted-claim ledger, stays in Phase 3.
 *
 * The two halves carry very different weight AT THIS PHASE, and saying so is
 * the point:
 *
 *   - The TYPE-LEVEL exclusion is what actually proves something now. It is a
 *     compile-time check over `keyof SensorContext`, so adding an executor,
 *     provider, lease or run member breaks `pnpm typecheck` -- not just this
 *     file.
 *   - The IMPORT-GRAPH lint had NOTHING DECLARED TO WALK at P1, because no
 *     sensor module existed yet. Ops Task 10 created the host probes, so
 *     `DECLARED_SENSOR_ROOTS` now names `plugins/ops-agent/src/probes` and the
 *     lint walks a real graph. It does NOT yet cover the collector, which is
 *     unwritten; this file must not be read as proving more topology than the
 *     roots it names.
 *
 * A guard that goes green because it found nothing to check is the failure
 * mode this task exists to prevent. That is why an empty declaration list is
 * allowed but a declared-then-missing root is a HARD FAILURE, and why that
 * rule is itself under test below rather than left as a promise.
 * @module contracts/topology-structure
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { SensorContext } from "@helium/core";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

// ---------------------------------------------------------------- type half

type ForbiddenSensorMember =
  | "executor"
  | "executors"
  | "registry"
  | "provider"
  | "providers"
  | "lease"
  | "leases"
  | "run";

/** Resolves to `never` only while SensorContext exposes none of them. */
type SensorContextIsNeutral = Extract<keyof SensorContext, ForbiddenSensorMember>;

const sensorContextIsNeutral: [SensorContextIsNeutral] extends [never]
  ? true
  : never = true;

// -------------------------------------------------------- import-graph half

/**
 * Roots the lint walks. Empty at Phase 1 by design -- see the module comment.
 * Each later task adds its own root as it creates it.
 *
 * Ops Task 10 adds `plugins/ops-agent/src/probes`, the host sensors. The
 * COLLECTOR is not declared here yet because it does not exist yet; when it
 * lands it is declared alongside these, and until then this list must not be
 * read as covering it.
 */
const DECLARED_SENSOR_ROOTS: string[] = [
  "plugins/ops-agent/src/probes",
  "plugins/ops-agent/src/collector.ts",
];

/**
 * Modules a sensor may never transitively reach. Declared only once the task
 * that creates them has landed; all three landed in Phase 1 Task 10.
 */
const DECLARED_FORBIDDEN_TARGETS = [
  "plugins/helium/src/executor-registry.ts",
  "packages/fake-metered/src/index.ts",
  "packages/fake-flat-rate/src/index.ts",
  "packages/core/src/operations/lease.ts",
];

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return tsFilesUnder(path);
      return path.endsWith(".ts") ? [path] : [];
    });
}

/**
 * Resolve declared roots to real, enumerable directories.
 *
 * @throws when a declared root does not exist or contains no module. A bare
 * `expect(reachable).not.toContain(path)` is vacuously true whenever the path
 * is absent from the tree -- it asserts nothing, and it keeps passing after a
 * rename. Every declared name must resolve.
 */
export function resolveRoots(names: string[]): string[] {
  return names.flatMap((name) => {
    const path = resolve(repoRoot, name);
    if (!existsSync(path)) {
      throw new Error(`declared sensor root does not resolve: ${name}`);
    }
    const files = statSync(path).isDirectory()
      ? tsFilesUnder(path)
      : path.endsWith(".ts")
        ? [path]
        : [];
    if (files.length === 0) {
      throw new Error(`declared sensor root enumerates no modules: ${name}`);
    }
    return files;
  });
}

/** @throws when a declared forbidden target does not resolve to a real module. */
export function resolveModules(names: string[]): string[] {
  return names.map((name) => {
    const path = resolve(repoRoot, name);
    if (!existsSync(path)) {
      throw new Error(`declared forbidden target does not resolve: ${name}`);
    }
    return path;
  });
}

const STATIC_IMPORT =
  /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*["']([^"']+)["']|(?:^|\n)\s*import\s*["']([^"']+)["']/g;

function resolveSpecifier(fromFile: string, specifier: string): string | undefined {
  if (specifier === "@helium/core") {
    return resolve(repoRoot, "packages/core/src/index.ts");
  }
  if (specifier.startsWith("@helium/core/")) {
    const subpath = specifier.slice("@helium/core/".length);
    const candidate = resolve(
      repoRoot,
      "packages/core/src",
      subpath.replace(/\.js$/, ".ts"),
    );
    return existsSync(candidate) && statSync(candidate).isFile()
      ? candidate
      : undefined;
  }
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(fromFile), specifier);
  for (const candidate of [
    base.replace(/\.js$/, ".ts"),
    `${base}.ts`,
    join(base, "index.ts"),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

/** Every module reachable from `roots` by STATIC import, roots included. */
export function transitiveStaticImports(roots: string[]): string[] {
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(STATIC_IMPORT)) {
      const specifier = match[1] ?? match[2];
      if (specifier === undefined) continue;
      const resolved = resolveSpecifier(file, specifier);
      if (resolved !== undefined && !seen.has(resolved)) queue.push(resolved);
    }
  }
  return [...seen].sort();
}

/**
 * Heuristics over module TEXT, used only to catch a forbidden module that was
 * renamed out of the declared list. The declared list is the primary check;
 * these are the backstop for a rename.
 */
const isExecutorImplementation = (path: string): boolean => {
  const text = readFileSync(path, "utf8");
  return text.includes("isolationClass") && text.includes("drain(");
};
const isProviderAdapter = (path: string): boolean =>
  readFileSync(path, "utf8").includes('from "node:child_process"');

describe("topology: the sensor context is provider-neutral", () => {
  it("exposes no executor, provider, lease or run member", () => {
    // The real assertion is the type above; typecheck fails before this runs
    // if SensorContext ever grows one of those members.
    expect(sensorContextIsNeutral).toBe(true);
  });
});

describe("topology: no sensor reaches an executor", () => {
  it("resolves every declared forbidden target to a real module", () => {
    const forbidden = resolveModules(DECLARED_FORBIDDEN_TARGETS);
    expect(forbidden).toHaveLength(DECLARED_FORBIDDEN_TARGETS.length);
  });

  it("records which roots were declared at this run", () => {
    // This assertion exists so that the day a root is added or dropped, the
    // change is visible here rather than silently widening -- or quietly
    // emptying -- a lint that had been passing.
    expect(DECLARED_SENSOR_ROOTS).toEqual([
      "plugins/ops-agent/src/probes",
      "plugins/ops-agent/src/collector.ts",
    ]);
  });

  it("walks a non-empty set of sensor modules", () => {
    // Guards the failure mode this file exists to prevent: a lint that goes
    // green because it found nothing to check.
    expect(resolveRoots(DECLARED_SENSOR_ROOTS).length).toBeGreaterThan(0);
  });

  it("finds no forbidden module reachable from any declared sensor root", () => {
    const roots = resolveRoots(DECLARED_SENSOR_ROOTS);
    const forbidden = resolveModules(DECLARED_FORBIDDEN_TARGETS);
    const reachable = transitiveStaticImports(roots);

    expect(reachable).toEqual(expect.not.arrayContaining(forbidden));
    expect(reachable.filter(isExecutorImplementation)).toEqual([]);
    expect(reachable.filter(isProviderAdapter)).toEqual([]);
  });
});

describe("topology: the lint fails loud rather than passing empty", () => {
  it("rejects a declared root that does not resolve", () => {
    expect(() => resolveRoots(["packages/core/src/no-such-sensors"])).toThrow(
      /does not resolve/,
    );
  });

  it("rejects a declared root that resolves but enumerates nothing", () => {
    expect(() => resolveRoots(["docs/evidence/p0"])).toThrow(
      /enumerates no modules/,
    );
  });

  it("rejects a declared forbidden target that does not resolve", () => {
    expect(() => resolveModules(["plugins/helium/src/renamed-away.ts"])).toThrow(
      /does not resolve/,
    );
  });

  it("actually walks a graph when given one", () => {
    // Proves the walker is not vacuous: from the registry, the fake executor
    // packages are NOT reachable (they are separate packages, reached by
    // specifier, not by a local edge), but core's own modules are.
    const reachable = transitiveStaticImports(
      resolveModules(["packages/core/src/index.ts"]),
    );
    expect(reachable.length).toBeGreaterThan(5);
    expect(reachable.some((p) => p.endsWith("/work.ts"))).toBe(true);
  });
});
