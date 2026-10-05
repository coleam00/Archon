---
title: Provider Capability Matrix
description: Canonical per-provider capability matrix, generated from each provider capabilities.ts.
category: reference
area: clients
audience: [user, developer]
status: current
sidebar:
  order: 10
---

<!-- AUTO-GENERATED — DO NOT EDIT. Regenerate with: bun run generate:capability-matrix -->

:::note
This page is **auto-generated** from each provider's `capabilities.ts` (the same
constants the workflow engine reads to enforce provider-specific behavior). Do not
edit it by hand — run `bun run generate:capability-matrix`.
A capability change fails `bun run validate` until this page is regenerated.
:::

Each column is a registered provider id (the value you set as `provider:` in a
workflow or `.archon/config.yaml`). A ✅ means Archon translates the corresponding
capability for that provider; a ❌ means the capability is unsupported. Unsupported
behavior is feature-specific: some optional fields are ignored with a warning, while
strict contracts fail closed. In particular, a node naming `mcp:`, `skills:` or
`plugins:` on a provider without that capability fails the run before any node
starts, and `context.resume` rejects an explicitly unsupported provider at load
time and an implicitly resolved one at runtime.

Reporting flags describe SDK fields that Archon translates into execution results.
Supported does not guarantee that every result reports a value or that usage includes
all nested agents. Unsupported fields remain absent; Archon does not estimate cost,
count events as turns, or substitute the requested model for an unreported model.
Cost reporting is independent of spend-limit support. Older providers may omit
reporting declarations; absence means unknown, not unsupported.

Background work: `reported` waits for runtime-reported task endings; `none` means verified absent;
`unobserved` means background work may exist without an observable lifecycle. A process
backgrounded inside a foreground shell command (`cmd &`) is invisible to every provider.
Codex observes subagents through `subAgentActivity` notifications and unified-exec processes
through `commandExecution` items with source `unifiedExecStartup`. It keeps the app-server
running after the parent result until those observed lifecycles end. This covers starts
observed before the parent's `turn/completed` and work started by those tasks (their
descendants). After parent completion the parent model cannot initiate new work, so
settlement is valid once the observed live set is empty. Starts first observed after
that point are outside this lifecycle contract. Idle thread status is not evidence
that this work has ended.

## Providers

- `claude` — Claude (Anthropic)
- `codex` — Codex (OpenAI)
- `opencode` — OpenCode (community) *(community provider, [deprecated](/getting-started/ai-assistants/#deprecated-providers))*
- `pi` — Pi (community) *(community provider)*
- `copilot` — Copilot (GitHub) *(community provider, [deprecated](/getting-started/ai-assistants/#deprecated-providers))*

## Capabilities

| Capability | `claude` | `codex` | `opencode` | `pi` | `copilot` |
| --- | --- | --- | --- | --- | --- |
| Background work observation | reported | reported | unobserved | none | unobserved |
| Session resume | ✅ | ✅ | ✅ | ✅ | ✅ |
| Immutable session fork (`context.resume`, cross-run `persist_session`) | ✅ | ✅ | ❌ | ✅ | ❌ |
| MCP servers (`mcp:`) | ✅ | ✅ | ❌ | ❌ | ✅ |
| Hooks (`hooks:`) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Skills (`skills:`) | ✅ | ❌ | ❌ | ✅ | ✅ |
| Plugins (`plugins:`) | ✅ | ✅ | ❌ | ❌ | ❌ |
| Inline sub-agents (`agents:`) | ✅ | ❌ | ✅¹ | ❌ | ✅ |
| Tool restrictions (`allowed_tools`/`denied_tools`) | ✅ | ❌ | ✅ | ✅ | ✅ |
| Structured output (`output_format`) | **enforced** | **enforced** | **enforced** | best-effort | best-effort |
| Env injection (`env:`) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Spend limit (`maxBudgetUsd`) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Cost reporting (`costUsd`) | ✅ | ❌ | ✅ | ✅ | ❌ |
| Token reporting | ✅ | ✅ | ✅ | ✅ | ✅ |
| Stop reason reporting | ✅ | ❌ | ✅ | ✅ | ❌ |
| Turn count reporting | ✅ | ❌ | ❌ | ❌ | ❌ |
| Resolved model reporting | ✅ | ❌ | ✅ | ✅ | ❌ |
| Effort control (`effort`) | ✅ | ✅ | ❌ | ✅ | ✅ |
| Fallback model (`fallbackModel`) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Sandbox (`sandbox`) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Setting sources (`settingSources`) | ✅ | ❌ | ❌ | ❌ | ❌ |
| In-process native tools | ✅ | ❌ | ❌ | ✅ | ❌ |
| Container exec (folder-project container backend) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Strict-mode `required` coverage (every key in `properties` MUST appear in `required`) | ❌ | ✅ | ❌ | ❌ | ❌ |

## Caveats

- ¹ `opencode` — Inline sub-agents (`agents:`) — Config-file-based agent selection (named agents from `opencode.json`) with per-call model/tools overrides — not inline sub-agent definitions.

## Legend

- **✅ / ❌** — the capability is supported or unsupported for this provider.
- **Unknown** — the provider has not declared whether this reporting channel is supported.
- **✅¹ (superscript)** — supported, but with semantics that differ from the headline
  meaning of the axis — see [Caveats](#caveats).
- **Structured output** — `enforced` (the SDK/backend grammar-constrains decoding),
  `best-effort` (schema appended to the prompt, then validated + re-asked up to 3×),
  or ❌ (unsupported). See [AI Assistants → Structured output guarantees](/getting-started/ai-assistants/#structured-output-guarantees).
- **In-process native tools** — the provider can register Archon `NativeTool`s for a
  turn (gates auto-injection of Archon's `manage_run` tool into project-scoped chat).

For per-provider field-level notes (YAML syntax, caveats), see the
[AI Assistants guide](/getting-started/ai-assistants/).
