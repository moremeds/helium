# Helium

Helium is the always-on agent harness for our research and operations ecosystem.

It turns small, declarative job files into isolated and observable agent runs.
DeepSeek Harness supplies the underlying agent runtime. Helium adds ecosystem
capabilities, triggers, escalation, persistence, delivery, health checks, and
release operations.

The current production release is `v0.1.5`.

## What works today

Helium v1 can:

- watch files, calendars, and schedules;
- collect evidence through an explicit tool allow-list;
- use a low-cost model for triage and escalate material events to a senior lane;
- write reports and append-only JSONL records;
- send rate-limited email;
- expose heartbeats, canaries, and dead-man monitoring;
- deploy tagged releases with a tested rollback path; and
- isolate a malformed tenant so it does not stop the others.

The first production tenant is `macro-watch`. `apex-health` and `dsh-canary`
exercise the same runtime for service health and harness compatibility.

```text
Trigger -> triage -> optional senior analysis -> report -> delivery
```

Helium v1 is a reliable single-agent compatibility runtime. The next program
adds durable multi-agent teams without breaking existing jobs.

## Where Helium is going

Helium's core will be model-blind. A team describes the capabilities it needs,
not a model vendor or model name. Pluggable providers register execution
targets and measured capability profiles. A router selects an eligible target
from task requirements, safety constraints, budget, latency, evaluations, and
operator preferences.

```text
Case event
   -> durable team controller
   -> capability router
   -> isolated agents
   -> evidence and cross-checks
   -> verified synthesis
   -> delivery gate
```

DeepSeek, Claude, Codex, local models, and future providers are inventory at the
edge of the system. They are never fixed roles inside Helium core.

See:

- [Helium v1 review](docs/reviews/2026-08-25-helium-v1-review.md)
- [Multi-agent design](docs/plans/2026-08-25-helium-multi-agent-design.md)
- [Multi-agent master plan](docs/plans/2026-08-25-helium-multi-agent-master-plan.md)

## Design principles

- Plugins instead of provider-specific branches
- Isolated context and least-privilege tools
- Explicit messages and artifacts instead of hidden shared context
- Append-only records before external side effects
- Deterministic policy around probabilistic agents
- Independent verification before delivery
- Restart-safe execution, bounded budgets, and fast rollback
- Measured capability routing instead of model reputation

## Repository map

- `packages/core` -- schemas, state, and ecosystem capabilities
- `plugins/helium` -- DeepSeek Harness integration
- `jobs` -- declarative v1 tenants
- `profile` -- deployable DSH profile
- `scripts` -- release, health, canary, and recovery operations
- `contracts` -- compatibility and runtime contracts
- `docs` -- design, evidence, reviews, and plans

## Development

Requirements:

- Node.js 22.19 or newer
- pnpm
- the exact DSH release candidate pinned by this repository

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm test:contracts
pnpm test:e2e-local
```

Normal CI does not call a live model. Live provider contracts are explicitly
opt-in and require their own credentials.

## Adding a v1 job

Start with an existing file in `jobs/`. A job declares its trigger, approved
tools, limits, and delivery policy. Job files are validated independently: one
invalid tenant must not take down the rest of the harness.

The multi-agent design replaces hard-coded engine selection with team roles,
capability requirements, routing policy, and verification policy. Existing v1
jobs will continue through a compatibility adapter.

## Safety

Read-only capability is the default. A prompt is never a permission boundary.
Mutating tools require explicit policy, process isolation, an audit trail, and
separate approval. Provider processes must not inherit undeclared tools,
settings, MCP servers, or workspace access.

Production changes go through pull requests and tagged releases. Do not push
directly to `master` and do not change the mini during an active acceptance
window.
