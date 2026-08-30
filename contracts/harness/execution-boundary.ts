/**
 * The reusable execution-boundary conformance harness.
 *
 * One suite, many subjects. A subject supplies only `invoke`; every assertion
 * lives here, so a second execution backend cannot quietly grade itself on an
 * easier exam. Phase 1 Task 10 adapts its `Executor` to
 * {@link ExecutionBoundarySubject} and inherits this suite verbatim — it does
 * not fork a second one.
 *
 * Deliberately NOT written over the P1 `Executor` type: that interface does
 * not exist until Task 10, and a harness that has to be rewritten when it
 * arrives is not reusable. The minimal subject shape below is the contract
 * both sides meet at.
 *
 * The evidence comes from `contracts/fixtures/senior-isolation/fake-claude.mjs`,
 * a fake `claude` binary the harness puts on the child's PATH. It reports what
 * actually reached the child; this file decides whether that is good enough.
 * @module @helium/contracts/harness/execution-boundary
 */
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** What a subject claims about what its child inherits. */
export type IsolationClass = "in-process" | "process" | "sandboxed";

export interface ExecutionBoundarySubject {
  readonly name: string;
  /** CLI boundary dialect. The assertions remain centralized in this suite. */
  readonly dialect?: "claude-cli" | "codex-cli";
  /** What the subject claims about what its child inherits. */
  readonly declaredIsolationClass: IsolationClass;
  /** Run one probe prompt under the supplied restriction and environment. */
  invoke(input: {
    prompt: string;
    allowedTools: string[];
    mcpConfigPath?: string;
    expectedWorkspace: string;
    env: Record<string, string>;
  }): Promise<{ text?: string }>;
}

/** Strength order. A subject must DEMONSTRATE at least what it declares. */
const RANK: Record<IsolationClass, number> = {
  "in-process": 0,
  process: 1,
  sandboxed: 2,
};

const FAKE_CLAUDE = fileURLToPath(
  new URL("../fixtures/senior-isolation/fake-claude.mjs", import.meta.url),
);
const FAKE_CODEX = fileURLToPath(
  new URL("../fixtures/senior-isolation/fake-codex.mjs", import.meta.url),
);

/**
 * Ambient environment the harness plants in its OWN process before invoking.
 * None of it is declared to the subject, so none of it may surface in the
 * child. The values are obviously-fake sentinels; a real secret must never
 * come near this file.
 */
const AMBIENT_MARKERS: Record<string, string> = {
  HELIUM_FORBIDDEN_SECRET: "helium-fake-sentinel-not-a-real-secret-0000",
  HELIUM_AMBIENT_MARKER: "helium-fake-ambient-marker-0000",
  ANTHROPIC_API_KEY: "sk-ant-helium-fake-not-a-real-key-0000",
};

/**
 * Flags that would hand the child an instruction file, an extra settings
 * source, an extra directory, or a way back to the full tool set. Any of them
 * defeats the boundary regardless of what `--tools` says.
 */
const UNDECLARED_SOURCE_FLAGS = [
  "--add-dir",
  "--settings",
  "--system-prompt",
  "--system-prompt-file",
  "--append-system-prompt",
  "--dangerously-skip-permissions",
  "--permission-prompt-tool",
];

/** Files that would silently re-inject instructions from inside the workspace. */
const INSTRUCTION_FILES = [
  "CLAUDE.md",
  "CLAUDE.local.md",
  "AGENTS.md",
  ".claude",
  ".mcp.json",
  ".claude.json",
  "settings.json",
];

interface BoundaryReport {
  proof: {
    strictMcp: boolean;
    toolsRestricted: boolean;
    settingsIsolated: boolean;
    ownedCwd: boolean;
    secretAbsent: boolean;
  };
  observed: {
    argv: string[];
    cwd: string;
    pid: number;
    envKeys: string[];
    envKeysReachingForbidden: string[];
    tools: string | null;
    allowedTools: string | null;
    settingSources: string | null;
    mcpConfigPath: string | null;
    mcpConfigCount: number;
    allowedToolsCount: number;
    mcpServers: string[] | null;
    mcpConfigError: string | null;
    exposedTools: string[];
    workspaceEntries: string[];
    escape: {
      readOutside: "allowed" | "blocked" | "missing";
      writeOutside: "allowed" | "blocked";
      wroteInsideWorkspace: boolean;
    };
  };
}

/** `true` when `child` is at or below `parent` — prefix-safe, unlike startsWith. */
function isContained(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The strongest class the evidence actually supports. Nothing here is taken on
 * the subject's word: a claim the harness cannot demonstrate grades down, and
 * grading down below the declaration fails the suite.
 */
function observedIsolationClass(report: BoundaryReport): {
  klass: IsolationClass;
  why: string[];
} {
  const why: string[] = [];
  const { proof, observed } = report;
  if (observed.pid === process.pid) why.push("child shares the harness pid");
  if (!proof.ownedCwd) why.push("child cwd is outside expectedWorkspace");
  if (!proof.secretAbsent) why.push("ambient secret reached the child");
  const leaked = Object.keys(AMBIENT_MARKERS).filter((k) =>
    observed.envKeys.includes(k),
  );
  if (leaked.length > 0) why.push(`ambient env leaked: ${leaked.join(", ")}`);
  if (why.length > 0) return { klass: "in-process", why };

  if (observed.escape.readOutside === "missing") {
    why.push("read-escape probe was inconclusive (target file missing)");
    return { klass: "process", why };
  }
  if (observed.escape.readOutside === "allowed") {
    why.push("child read a file outside expectedWorkspace");
  }
  if (observed.escape.writeOutside === "allowed") {
    why.push("child wrote a file outside expectedWorkspace");
  }
  return { klass: why.length === 0 ? "sandboxed" : "process", why };
}

/**
 * Registers the shared describe/it block for one subject.
 *
 * Runs the subject twice, per plan Task 2 Step 4: once with a single allowed
 * MCP tool and once with no tools at all. The MCP config is supplied in both
 * cases because that is what production does — helium always writes
 * `<stateRoot>/mcp.json`; an empty `job.tools` is what makes the second case
 * "no tools".
 */
export function runExecutionBoundaryConformance(
  subject: ExecutionBoundarySubject,
): void {
  describe(`execution boundary: ${subject.name} (declares ${subject.declaredIsolationClass})`, () => {
    let root: string;
    let binDir: string;
    let mcpConfigPath: string;
    const savedAmbient: Record<string, string | undefined> = {};

    beforeAll(() => {
      // realpath: on macOS `tmpdir()` is a symlink (/var -> /private/var) and
      // the child's own `process.cwd()` reports the resolved path, so an
      // unresolved expectedWorkspace would fail `ownedCwd` for the wrong
      // reason.
      root = realpathSync(mkdtempSync(join(tmpdir(), "helium-boundary-")));

      // A `claude` on PATH. A shell shim rather than a copy of the .mjs: a
      // file named `claude` in a directory with no package.json would be
      // loaded as CommonJS and the fixture's ESM syntax would not parse.
      binDir = join(root, "bin");
      mkdirSync(binDir, { recursive: true });
      for (const [name, fixture] of [
        ["claude", FAKE_CLAUDE],
        ["codex", FAKE_CODEX],
      ] as const) {
        const shim = join(binDir, name);
        writeFileSync(
          shim,
          `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fixture)} "$@"\n`,
          "utf8",
        );
        chmodSync(shim, 0o755);
      }

      // Exactly one declared MCP server, written at runtime the way
      // production writes <stateRoot>/mcp.json.
      mcpConfigPath = join(root, "mcp.json");
      writeFileSync(
        mcpConfigPath,
        `${JSON.stringify(
          {
            mcpServers: {
              helium: { command: process.execPath, args: ["-e", ""] },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      // Plant the undeclared ambient environment the child must never see.
      for (const [key, value] of Object.entries(AMBIENT_MARKERS)) {
        savedAmbient[key] = process.env[key];
        process.env[key] = value;
      }
    });

    afterAll(() => {
      for (const [key, previous] of Object.entries(savedAmbient)) {
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }
      rmSync(root, { recursive: true, force: true });
    });

    const scenarios = [
      {
        title: "with one allowed MCP tool",
        allowedTools: ["mcp__helium__thesis_read"],
      },
      { title: "with no tools", allowedTools: [] as string[] },
    ];

    for (const scenario of scenarios) {
      describe(scenario.title, () => {
        let workspace: string;
        let declaredEnv: Record<string, string>;
        let report: BoundaryReport;

        beforeAll(async () => {
          workspace = join(root, "workspaces", subject.name, randomUUID());
          mkdirSync(workspace, { recursive: true });
          // The complete declared environment. PATH is narrowed to the shim
          // directory alone, so nothing the operator happens to have on PATH
          // is reachable either.
          declaredEnv = {
            PATH: binDir,
            HELIUM_EXPECTED_WORKSPACE: workspace,
          };
          const out = await subject.invoke({
            prompt: "Report the execution boundary you were given.",
            allowedTools: scenario.allowedTools,
            mcpConfigPath,
            expectedWorkspace: workspace,
            env: { ...declaredEnv },
          });
          expect(
            out.text,
            "subject.invoke() returned no text; the child produced no boundary report",
          ).toBeTruthy();
          report = JSON.parse(out.text as string) as BoundaryReport;
        });

        it("proves strict MCP, restricted tools, isolated settings, an owned cwd and no ambient secret", () => {
          expect(report.proof).toEqual({
            strictMcp: true,
            toolsRestricted: true,
            settingsIsolated: true,
            ownedCwd: true,
            secretAbsent: true,
          });
        });

        it("keeps the declared tool list exactly as declared, empty included", () => {
          const { observed } = report;
          expect(observed.exposedTools).toEqual(scenario.allowedTools);
          if (subject.dialect === "codex-cli") {
            expect(observed.argv).toEqual(
              expect.arrayContaining([
                "--ignore-user-config",
                "--ignore-rules",
                "--strict-config",
              ]),
            );
            for (const value of [
              "features.shell_tool=false",
              "features.unified_exec=false",
              "tools.web_search=false",
              "tools.view_image=false",
              "features.multi_agent=false",
              "agents.enabled=false",
            ]) {
              expect(observed.argv).toContain(value);
            }
            expect(observed.argv).not.toContain("--dangerously-bypass-approvals-and-sandbox");
            return;
          }
          // `--tools ""` disables the built-in set; `--allowedTools` is the
          // only flag that carries mcp__* names. Both must be present with
          // exactly the declared value — an empty declared set must stay an
          // empty argv value, not disappear into the provider default.
          expect(observed.tools).toBe("");
          expect(observed.allowedToolsCount).toBe(1);
          expect(observed.allowedTools).toBe(scenario.allowedTools.join(","));
          for (const flag of ["--dangerously-skip-permissions"]) {
            expect(observed.argv).not.toContain(flag);
          }
        });

        it("admits no undeclared MCP server, setting source, instruction file or environment secret", () => {
          const { observed } = report;

          expect(observed.mcpConfigError).toBeNull();
          expect(observed.mcpConfigCount).toBe(1);
          expect(observed.mcpServers).toEqual(["helium"]);
          if (subject.dialect === "codex-cli") {
            expect(observed.mcpConfigPath).toBeNull();
            expect(observed.argv).toContain("--strict-config");
            expect(observed.argv).toContain("mcp_servers.helium.required=true");
            expect(observed.settingSources).toBeNull();
          } else {
            expect(observed.mcpConfigPath).toBe(mcpConfigPath);
            expect(observed.argv).toContain("--strict-mcp-config");
            expect(observed.settingSources).toBe("");
          }

          for (const flag of UNDECLARED_SOURCE_FLAGS) {
            expect(observed.argv).not.toContain(flag);
          }
          for (const entry of observed.workspaceEntries) {
            expect(INSTRUCTION_FILES).not.toContain(entry);
          }

          // The child's environment may hold only keys the harness declared
          // plus whatever transport the subject legitimately adds; it may
          // never hold a key the harness planted but did not declare.
          for (const key of Object.keys(declaredEnv)) {
            expect(observed.envKeys).toContain(key);
          }
          for (const key of Object.keys(AMBIENT_MARKERS)) {
            expect(observed.envKeys).not.toContain(key);
          }
          expect(observed.envKeysReachingForbidden).toEqual([]);
        });

        it("confines the child to expectedWorkspace as strongly as its class allows", () => {
          const { observed } = report;
          expect(isContained(workspace, observed.cwd)).toBe(true);
          expect(observed.escape.wroteInsideWorkspace).toBe(true);
          // A probe that could not run grades nothing. Demand a verdict
          // before using it as evidence either way.
          expect(
            observed.escape.readOutside,
            "read-escape probe was inconclusive; the harness cannot grade containment",
          ).not.toBe("missing");
          // A `sandboxed` subject owes real filesystem containment. A
          // `process` subject does not have one — a plain `claude -p` child
          // can read any file its uid can — and asserting otherwise here
          // would be a false claim, not a stronger test. What IS demanded of
          // every class is that nothing the subject handed the child routes
          // it outside: no extra directory, no env value pointing out.
          if (RANK[subject.declaredIsolationClass] >= RANK.sandboxed) {
            expect(observed.escape.readOutside).toBe("blocked");
            expect(observed.escape.writeOutside).toBe("blocked");
          } else {
            expect(observed.argv).not.toContain("--add-dir");
            expect(observed.envKeysReachingForbidden).toEqual([]);
          }
        });

        it("demonstrates a boundary at least as strong as declaredIsolationClass", () => {
          const { klass, why } = observedIsolationClass(report);
          expect(
            RANK[klass],
            `${subject.name} declares "${subject.declaredIsolationClass}" but only "${klass}" is demonstrable: ${why.join("; ") || "no evidence"}`,
          ).toBeGreaterThanOrEqual(RANK[subject.declaredIsolationClass]);
        });
      });
    }
  });
}
