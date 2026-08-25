# Model Selection Probe — Mac mini

**Date:** 2026-08-25

**Status:** Verified against the live provider entitlements on the Mac mini

## Decision

Concrete provider and model names belong in provider-plugin catalogs, not in
Helium core, work orders, roles, or team manifests. Core continues to request
capabilities and receives an opaque execution lease. The provider plugin owns
the selectable model list, authentication route, invocation name, lifecycle
state, and exact runtime audit record.

This probe validates access and model identity. It does not rank output quality.
Capability scores still require representative Helium evaluations.

## Probe conditions

- Host: the production Mac mini.
- DeepSeek: direct API authentication.
- Claude: Claude Code subscription OAuth, with API-key variables removed.
- Codex: ChatGPT subscription OAuth, using the Codex executable bundled with
  the ChatGPT app.
- Every request used an isolated temporary directory, no tools, and the prompt
  `Reply with exactly HELIUM_MODEL_OK`.
- No release, service, job, credential, or production-state file was changed.

## Verified options

### DeepSeek API

The live `/models` response returned three targets. All three accepted a chat
completion and returned the expected response.

| Exact model ID | Result | Wall time | Initial catalog state |
|---|---:|---:|---|
| `deepseek-v4-flash` | PASS | 1.007 s | enabled |
| `deepseek-v4-pro` | PASS | 1.412 s | enabled |
| `deepseek-v4-flash-vision-exp` | PASS | 0.993 s | disabled until multimodal certification |

DeepSeek's official integration documentation describes V4 Pro and V4 Flash as
reasoning models. The vision target is present in the live account catalog but
is explicitly experimental, so successful text generation is not sufficient
for production routing. See the [DeepSeek model-list API](https://api-docs.deepseek.com/api/list-models)
and [chat-completion API](https://api-docs.deepseek.com/api/create-chat-completion).

### Claude Code subscription

Both the stable aliases and the resolved exact IDs were tested. The exact IDs
below all returned the expected response.

| UI alias | Exact selected model | Effort options | Default | Result | Wall time |
|---|---|---|---|---:|---:|
| `haiku` | `claude-haiku-4-5-20251001` | unsupported | none | PASS | 4.751 s |
| `sonnet` | `claude-sonnet-5` | `low`, `medium`, `high`, `xhigh`, `max` | `high` | PASS | 4.387 s |
| `opus` | `claude-opus-5` | `low`, `medium`, `high`, `xhigh`, `max` | `high` | PASS | 3.995 s |

Claude Code also reported Haiku usage during the Sonnet and Opus calls. The
provider adapter must therefore persist the complete `modelUsage` map, not
only the requested foreground model.

Effort remains provider-owned. The router chooses among measured model-effort
variants, while normal work orders and team manifests cannot name either field.
Claude's `ultracode` is a separate orchestration mode and is disabled because
Helium owns multi-agent decomposition and spawning.

The official picker also exposes dynamic or composite choices such as `best`,
`fable`, `sonnet[1m]`, `opus[1m]`, and `opusplan`. They should not be registered
as ordinary exact targets: `best` can change resolution, `opusplan` is a mode,
and Fable can consume usage credits in non-interactive execution. They remain
disabled until a separate entitlement and billing-policy probe is approved.
See [Claude Code model configuration](https://code.claude.com/docs/en/model-config).

### Codex subscription

The local ChatGPT account catalog returned seven targets. Every target accepted
an isolated `codex exec` request and returned the expected response.

| Exact model ID | Result | Wall time | Initial catalog state |
|---|---:|---:|---|
| `gpt-5.6-sol` | PASS | 7.982 s | enabled |
| `gpt-5.6-terra` | PASS | 6.633 s | enabled |
| `gpt-5.6-luna` | PASS | 6.156 s | enabled |
| `gpt-5.5` | PASS | 6.025 s | available, legacy |
| `gpt-5.4` | PASS | 6.861 s | disabled; retires 2026-08-31 |
| `gpt-5.4-mini` | PASS | 6.110 s | disabled; retires 2026-08-31 |
| `codex-auto-review` | PASS | 6.064 s | special review target, not general routing |

OpenAI describes Sol as the complex, open-ended option, Terra as the everyday
all-rounder, and Luna as the fast option for clear, repeatable work. The same
official page records the August 31 retirement of GPT-5.4 and GPT-5.4 mini for
ChatGPT-authenticated Codex. See [Codex models](https://developers.openai.com/codex/models).

## Provider-catalog seed

This is an edge-plugin inventory, not a core or team configuration:

```yaml
providers:
  deepseek-api:
    access: api
    options:
      - model: deepseek-v4-flash
        enabled: true
      - model: deepseek-v4-pro
        enabled: true
      - model: deepseek-v4-flash-vision-exp
        enabled: false
        reason: experimental-multimodal-target

  claude-subscription:
    access: claude-code-oauth
    options:
      - model: claude-haiku-4-5-20251001
        invoke_as: haiku
        enabled: true
        effort:
          supported: false
      - model: claude-sonnet-5
        invoke_as: sonnet
        enabled: true
        effort:
          supported: true
          options: [low, medium, high, xhigh, max]
          default: high
      - model: claude-opus-5
        invoke_as: opus
        enabled: true
        effort:
          supported: true
          options: [low, medium, high, xhigh, max]
          default: high
    execution_modes:
      ultracode:
        enabled: false
        reason: provider-owned-agent-orchestration

  codex-subscription:
    access: chatgpt-oauth
    options:
      - model: gpt-5.6-sol
        enabled: true
      - model: gpt-5.6-terra
        enabled: true
      - model: gpt-5.6-luna
        enabled: true
      - model: gpt-5.5
        enabled: false
        reason: legacy
      - model: gpt-5.4
        enabled: false
        reason: retires-2026-08-31
      - model: gpt-5.4-mini
        enabled: false
        reason: retires-2026-08-31
      - model: codex-auto-review
        enabled: false
        reason: special-review-target
```

The catalog may seed capabilities from provider documentation, but routing must
use Helium's measured task evaluations. For example, a tenant preference for
Luna's document style should be a bounded preference boost for a writing task
class, not a hard-coded role-to-model assignment.

## Production safety check

Before and after the probe:

- DSH remained PID `71966` on release `v0.1.5`;
- the loopback UI remained HTTP `200` on port `3080`;
- the current heartbeat file advanced from 826 to 878 lines; and
- no probe temporary directory remained.
