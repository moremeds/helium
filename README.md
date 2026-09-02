# Helium

Helium is a multipurpose, multi-agent harness that improves itself.

DeepSeek Harness (dsh) supplies the agent runtime as an in-process library:
sessions, subagents, tools, compaction, approval and its same-world sandbox are
consumed, never reimplemented. Helium adds the four things dsh has no opinion
on — multi-tenancy, capability routing, sandbox kinds beyond same-world, and a
queryable token audit.

**Status: v2, rebuilt from scratch.** The v1 job/ops/SOP lanes were deleted
rather than migrated; they authorized an empty set and delivered nothing. The
design of record is `docs/plans/2026-09-02-helium-v2-design.md`, and the six
doctrine points it answers to live in this checkout's `AGENTS.md` (untracked by
design — it describes the machine, not the project).

## What works today

- `helium run <tenant>` discovers tenants by glob, routes each role by
  capability, runs the team, and writes one audit span per step.
- `helium audit <run-id>` answers "where did the tokens go" from a SQLite table
  folded out of the dsh session log.
- Three provider plugins ship: Claude subscription, Codex subscription, and
  DeepSeek via dsh. A role declares `requires: [capability]` and never a model.
- `plugins/delivery-email` sends a result off the machine under a daily cap.

Not yet: sandbox kind implementations, gate discovery, and the two real tenants
(option-wizard, livewire build/heal). See the design doc's build order.

## Repository map

- `packages/core` — the four Helium-owned nouns and nothing else
- `packages/cli` — `helium run` / `helium audit`
- `packages/provider-sdk` — the executor and receipt seam providers implement
- `plugins/provider-*` — one directory per vendor; `provider-dsh` is the only
  source naming `@deepseek-ai/*`
- `plugins/delivery-*` — result channels
- `plugins/fake-tenant` — the domain-free seam proof
- `contracts` — three tests that earn their keep (see below)
- `docs/plans` — designs of record

## Contracts

Three, deliberately. Each one has caught a real defect or mechanically enforces
a doctrine point that nothing else can:

- `core-neutrality` — nothing under `packages/core/src` names a provider or a
  business domain.
- `tool-restriction` — a tool outside the allow-list disappears from the agent's
  own scoped view, even with mutations enabled. Fail-closed.
- `provider-executor-conformance` — every provider proves the same execution
  boundary: declared tools only, no ambient secret, an owned working directory.

A fourth, `sandbox-write-boundary`, arrives with the sandbox kinds.

## Development

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test            # unit
pnpm test:contracts  # the three above
node packages/cli/lib/cli.js run fake-tenant
```

Node 22.19+ or 24+. Deleting `lib/` without also deleting `tsconfig.tsbuildinfo`
makes `tsc` emit nothing and every dependent package fail to resolve
`@helium/core` — remove both or neither.

## Adding a tenant

Write `plugins/<name>/{tenant.yaml,team.yaml,tools/index.ts}`. There is no
registry to edit and no core change to make. A malformed manifest, a throwing
tool module or a role naming an unknown tool skips that tenant with a recorded
reason; only a duplicate tenant name fails the whole load.

## Safety

Read-only is the default and a prompt is never a permission boundary.
`packages/core/src/mcp/selection.ts` is the single place that resolves the tool
allow-list and the mutation flag, and it fails closed: a tool outside the
allow-list is dropped even with mutations enabled.

Blast radius is defined by where an agent runs, not by signatures. Outside a
sandbox two rules hold: never write the production data lake, never place an
order.

## License

MIT.
