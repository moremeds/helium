# Provider effort certification — 2026-08-30

This record is a sanitized entitlement and invocation snapshot for the Phase 2
production provider plane. It is not a quality evaluation. Runtime eligibility
is represented by the schema-validated artifacts in
`plugins/helium/src/provider-certifications.ts`; catalog inventory alone never
creates an execution target.

| Provider | Exact target | Preflight | Invocation | Availability | Routing eligibility | Quality evidence |
| --- | --- | --- | --- | --- | --- | --- |
| Codex subscription | `gpt-5.6-sol` / `high` | Codex CLI 0.151.0 accepted the strict, tool-disabled adapter configuration | PASS; requested and adapter-effective effort were both `high`, provider-reported effort was not emitted, exact sentinel returned | available at certification time | eligible | deferred (v2) |
| DeepSeek DSH | `deepseek-v4-flash` / `high` | blocked: no `DEEPSEEK_API_KEY` was present in the development environment | not run | unavailable | not registered | deferred (v2) |
| Claude subscription | `claude-opus-5` / `max` | blocked: subscription quota exhausted | deliberately not run | quota-exhausted | not registered | deferred (v2) |

The first Codex preflight also exposed that the ambient Codex CLI 0.140.0 was
too old for `gpt-5.6-sol`, and that two legacy strict-config keys were rejected
by current Codex. The adapter now uses only accepted fail-closed keys and
supports execution in a newly-created non-Git workspace. Certification passed
through the real adapter with an empty mode-0700 workspace, read-only sandbox,
no allowed tools, and no MCP servers; the workspace was removed afterward.
The same adapter probe passed again after the ambient CLI was upgraded to
0.151.0, so the runnable production command now matches the certified path.

The published artifact intentionally contains exactly one target. DeepSeek and
Claude have empty target lists until a later isolated live preflight succeeds.
Their catalog entries remain documentation only and cannot enter routing.

Dynamic capacity is separate from entitlement. A quota result atomically marks
the provider's shared domain exhausted. The provider-owned refresh callback is
the only normal restoration path; persisted exhaustion is rechecked once at
startup, and repeated exhaustion schedules an unreferenced 15-minute retry
rather than a busy loop. Reset hints remain opaque.
