# Topology Graph Reminder Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show Helium's planned canonical topology in both the README and the
multi-agent design without confusing it with the deployed v1 path.

**Architecture:** The multi-agent design remains normative. README repeats the
same compact Mermaid block as a reminder, labels it as planned v2, and links to
the canonical design; the detailed text contracts remain only in the design.

**Tech Stack:** Markdown, Mermaid, Node.js documentation checks, GitHub rendering.

---

### Task 1: Add the canonical topology reminder to README

**Files:**

- Modify: `README.md:35-58`
- Verify: `docs/plans/2026-08-25-helium-multi-agent-design.md:183-213`

**Step 1: Verify the README does not yet contain the canonical Mermaid graph**

Run:

```bash
rg -n '^flowchart TB$' README.md
```

Expected: exit 1 with no match.

**Step 2: Replace the README's compact text topology**

Replace the existing `text` diagram under `Where Helium is going` with the
approved Mermaid diagram from design Section 5.5. Add one sentence stating that
it is the planned v2 topology, not the currently deployed v1 path, and link the
word `canonical design` to that section.

Do not put DeepSeek, Claude, Codex, effort levels, or model names inside the
graph. They remain opaque inventory behind `Provider Edge`.

**Step 3: Verify both files contain the same graph**

Run a read-only Node check that extracts the first `flowchart TB` Mermaid block
from README and the canonical design and compares their exact contents.

Expected: PASS with identical blocks.

**Step 4: Run documentation and repository checks**

Run:

```bash
git diff --check
pnpm build
pnpm typecheck
pnpm test
pnpm test:contracts
pnpm test:e2e-local
```

Expected: all commands pass; the opt-in live provider contract may remain
skipped when live credentials are not enabled.

**Step 5: Commit**

```bash
git add README.md docs/plans/2026-08-26-topology-graph-reminder.md
git commit -m "docs: surface the canonical topology in readme"
```
