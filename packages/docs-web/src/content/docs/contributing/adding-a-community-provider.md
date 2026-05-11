---
title: Adding a Community Provider
description: Step-by-step guide to adding a new AI agent provider under packages/providers/src/community/.
---

Archon's provider registry (Phase 2, [#1195](https://github.com/coleam00/Archon/pull/1195)) is designed so community providers can be added with changes localized to a single directory. This guide walks through the pattern using the Pi provider as the reference implementation (`packages/providers/src/community/pi/`).

## The contract

Every provider implements `IAgentProvider` from `@archon/providers/types`:

```typescript
export interface IAgentProvider {
  sendQuery(
    prompt: string,
    cwd: string,
    resumeSessionId?: string,
    options?: SendQueryOptions,
  ): AsyncGenerator<MessageChunk>;

  getType(): string;
  getCapabilities(): ProviderCapabilities;
}
```

The provider yields a stream of `MessageChunk` variants (see `packages/providers/src/types.ts`). Archon normalizes every backend to this shape so platform adapters, the DAG executor, and the orchestrator don't need to know whether they're talking to Claude, Codex, Pi, or your provider.

## Directory layout

A community provider lives entirely under `packages/providers/src/community/<your-provider-id>/`. The Pi provider uses this layout:

```
packages/providers/src/community/pi/
├── provider.ts          # PiProvider class (IAgentProvider impl)
├── capabilities.ts      # PI_CAPABILITIES constant
├── config.ts            # parsePiConfig, PiProviderDefaults
├── model-ref.ts         # model-string parsing + compat check
├── event-bridge.ts      # SDK-event → MessageChunk conversion
├── session-resolver.ts  # optional: session lifecycle helpers
├── options-translator.ts  # optional: nodeConfig → SDK-options translation
├── registration.ts      # registerPiProvider()
├── resource-loader.ts   # optional: SDK-specific helpers
├── index.ts             # public exports
└── *.test.ts            # co-located tests
```

Each file has one job. Optional files only exist when the translation surface is non-trivial — a minimal provider could fit `provider.ts` + `capabilities.ts` + `registration.ts` + `index.ts` + one test file.

## Step-by-step

### 1. Capabilities (start honest)

Declare only what you've actually wired. The dag-executor emits a warning to the user when a workflow node uses a feature your provider doesn't support — under-declaration is self-correcting via those warnings; over-declaration means Archon silently drops configuration.

```typescript
// capabilities.ts
import type { ProviderCapabilities } from '../../types';

export const YOUR_CAPABILITIES: ProviderCapabilities = {
  sessionResume: false,
  mcp: false,
  hooks: false,
  skills: false,
  toolRestrictions: false,
  structuredOutput: false,
  envInjection: false,
  costControl: false,
  effortControl: false,
  thinkingControl: false,
  fallbackModel: false,
  sandbox: false,
};
```

Start everything at `false`. Flip to `true` one at a time as you wire each translation, and add a test per flip.

### 2. Provider class

Implement `IAgentProvider`. Pattern:

```typescript
// provider.ts
import { createLogger } from '@archon/paths';
import type { IAgentProvider, MessageChunk, ProviderCapabilities, SendQueryOptions } from '../../types';
import { YOUR_CAPABILITIES } from './capabilities';

let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog() {
  if (!cachedLog) cachedLog = createLogger('provider.your-id');
  return cachedLog;
}

export class YourProvider implements IAgentProvider {
  async *sendQuery(prompt, cwd, resumeSessionId, options): AsyncGenerator<MessageChunk> {
    // 1. Parse assistantConfig (user-level defaults from .archon/config.yaml)
    // 2. Resolve model (options.model || config default)
    // 3. Resolve auth (options.env → process.env → config)
    // 4. Translate nodeConfig to SDK options (only for capabilities you declared)
    // 5. Invoke SDK, yield normalized MessageChunks
    // 6. Include sessionId in final `result` chunk (for resume)
  }

  getType() { return 'your-id'; }
  getCapabilities() { return YOUR_CAPABILITIES; }
}
```

See `packages/providers/src/community/pi/provider.ts` for a full reference with retry, fail-fast auth validation, and resume fallback.

### 3. Registration

Each community provider exports a `register*Provider()` function. Idempotent — guard with `isRegisteredProvider(id)` so it's safe to call from multiple bootstrap sites.

```typescript
// registration.ts
import { isRegisteredProvider, registerProvider } from '../../registry';
import { YOUR_CAPABILITIES } from './capabilities';
import { YourProvider } from './provider';

export function registerYourProvider(): void {
  if (isRegisteredProvider('your-id')) return;
  registerProvider({
    id: 'your-id',
    displayName: 'Your Provider (community)',
    factory: () => new YourProvider(),
    capabilities: YOUR_CAPABILITIES,
    builtIn: false, // ← important: community providers are NOT built-in
  });
}
```

Then add one line to the aggregator at `packages/providers/src/registry.ts`:

```typescript
export function registerCommunityProviders(): void {
  registerPiProvider();
  registerYourProvider(); // ← add your provider here
}
```

**That is the entire cross-cutting change.** No entrypoint edits, no config-type edits. The aggregator is already called from the CLI, server, and config-loader bootstrap paths.

### 4. Tests

Co-locate tests next to your code. The Pi tests use this isolation pattern:

- Mock the SDK (`mock.module` at the top of the file, before importing your provider).
- Tests that touch `mock.module` are split into separate `bun test` invocations in `packages/providers/package.json` (see existing entries for the Pi files). Bun's `mock.module` is process-global and irreversible — splitting prevents cross-file pollution.
- Registry test (`packages/providers/src/registry.test.ts`): add a `describe` block asserting `builtIn: false` and idempotent registration.

### 5. Capability discipline

When you're ready to wire additional capabilities, each translation gets its own small module. Pi uses:

- `options-translator.ts` for thinking level, tool filters, skills resolution
- `session-resolver.ts` for session create/open/list
- `event-bridge.ts` for SDK-event → MessageChunk mapping

This keeps the provider class readable — `provider.ts` orchestrates; the translators are unit-testable without the SDK.

## What NOT to do

- **Don't edit `AssistantDefaultsConfig` or `AssistantDefaults` in `packages/core/src/config/config-types.ts`.** Community provider defaults live behind the generic `[string]` index signature that was designed for this case. Adding a typed slot defeats the Phase 2 contract and forces future providers to follow suit.
- **Don't call `registerProvider()` from CLI or server entrypoints directly.** Use the `registerCommunityProviders()` aggregator. Entrypoints should never grow per-community-provider calls.
- **Don't overclaim capabilities.** If a workflow node uses `hooks: [...]` and your provider silently ignores it, the user has no feedback. The dag-executor warns honestly if you declare `hooks: false`.
- **Don't write session state or credentials outside your provider's SDK-managed directory.** Archon's config, workspaces, and sessions are managed elsewhere — your provider should stay within its own SDK's storage conventions (mirror how Claude writes to `~/.claude/` and Codex uses its thread store).

## Reference implementation

The Pi provider at `packages/providers/src/community/pi/` is the canonical example. It covers:

- Multi-backend model selection via `<pi-provider>/<model-id>` refs (parse once, validate syntactically)
- OAuth + API-key passthrough (reads `~/.pi/agent/auth.json`, overrides per-request)
- Async-queue bridge from callback-based SDK events to `AsyncGenerator<MessageChunk>`
- Session resume via `SessionManager.list(cwd)` + `SessionManager.open(path)`
- Capability translations: `effort/thinking`, `allowed_tools/denied_tools`, `skills`, `systemPrompt`

Read `packages/providers/src/community/pi/provider.ts` top-to-bottom — the comments call out every design decision and link to the upstream Pi SDK behavior.
