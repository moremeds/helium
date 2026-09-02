/**
 * Sandbox kinds: WHERE a run executes, which is v2's whole definition of blast
 * radius (doctrine 5). Not a signature, not an authority manifest -- a
 * filesystem and process boundary a run is placed inside.
 *
 * INTERFACE ONLY. Implementations are plugins (`plugins/sandbox-<id>/sandbox.ts`)
 * and land in M3 together with the write-boundary guard and its contract test.
 * Nothing in core creates or destroys a sandbox; core only names the shape so
 * that a role manifest can require one and the runner can refuse a run whose
 * kind is not installed.
 * @module @helium/core/sandbox
 */

/**
 * The kinds core knows to ASK for. A plugin may register any id; these four
 * are the ones a manifest may name without one installed being a typo.
 * `none` is the same-world default dsh already gives us.
 */
export const BUILTIN_SANDBOX_KINDS = [
  "none",
  "scratch",
  "dsh-home",
  "worktree",
] as const;
export type BuiltinSandboxKind = (typeof BUILTIN_SANDBOX_KINDS)[number];

export interface SandboxSpec {
  /** Which kind to create; a plugin id or one of the builtins. */
  kind: string;
  /** The run this sandbox belongs to; used for naming and cleanup only. */
  runId: string;
  /** Absolute paths the run may read. Everything else is out of reach. */
  readRoots: string[];
  /**
   * Absolute paths the run may WRITE. The guard is fail-closed: a write
   * outside this list is refused under every kind, `none` included.
   */
  writeRoots: string[];
}

export interface SandboxHandle {
  kind: string;
  /** Absolute path the run's cwd is set to. */
  root: string;
  /** The resolved, absolute write boundary the guard enforces. */
  writeRoots: string[];
  /** Kind-specific detail (a branch name, a $DSH_HOME, …). Opaque to core. */
  detail?: Record<string, unknown>;
}

export interface SandboxKind {
  id: string;
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  destroy(handle: SandboxHandle): Promise<void>;
}
