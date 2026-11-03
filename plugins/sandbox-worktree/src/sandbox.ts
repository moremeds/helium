import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SandboxKind } from "@helium/core";

function git(cwd: string, ...args: string[]): string {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  // ponytail: bot gh config is omitted; P6 uses a dedicated bot-only user.
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: "pipe" }).trim();
}

export default {
  id: "worktree",
  async create(spec) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(spec.runId)) throw new Error("invalid worktree run id");
    const repo = git(spec.readRoots[0] ?? process.cwd(), "rev-parse", "--show-toplevel");
    const root = join(repo, ".worktrees", spec.runId);
    const branch = `agent/${spec.runId}`;
    mkdirSync(join(repo, ".worktrees"), { recursive: true });
    git(repo, "worktree", "add", root, "-b", branch);
    return { kind: "worktree", root, writeRoots: [], detail: { repo, branch } };
  },
  async destroy(handle) {
    const detail = handle.detail!;
    try {
      if (git(handle.root, "status", "--porcelain", "--untracked-files=all") !== "") detail.retainedReason = "dirty";
      else if (!git(String(detail.repo), "branch", "--merged", "HEAD", "--format=%(refname:short)").split("\n").includes(String(detail.branch))) detail.retainedReason = "unmerged";
      else git(String(detail.repo), "worktree", "remove", handle.root);
    } catch (error) {
      detail.retainedReason = error instanceof Error ? error.message : String(error);
    }
  },
} satisfies SandboxKind;
