# OpenCode Community Provider Design

> Date: 2026-04-23
> Author: choufeng
> Reference: Issue #1151

## Goal

Add OpenCode as a community provider to Archon, enabling users to use OpenCode's AI coding agent as a backend for Archon workflows.

## Architecture

OpenCode is a client/server AI coding agent (unlike Claude Code/Codex which are monolithic CLIs). The provider will:

1. **Lazy-start** an OpenCode Server (`opencode serve`) on first use
2. **Connect** via `@opencode-ai/sdk` using `createOpencodeClient`
3. **Bridge** SSE events to Archon's `MessageChunk` async generator contract
4. **Manage** session lifecycle (create/resume/abort)

## Key Differences from Pi Provider

| Aspect | Pi | OpenCode |
|--------|-----|----------|
| SDK loading | Dynamic import with `PI_PACKAGE_DIR` shim | Clean dynamic import |
| Auth | OAuth + API key file (`~/.pi/agent/auth.json`) | HTTP Basic Auth (`OPENCODE_SERVER_PASSWORD`) |
| Model refs | `<pi-provider>/<model-id>` | `<provider-id>/<model-id>` |
| Session storage | `~/.pi/agent/sessions/` (filesystem) | OpenCode Server internal |
| Structured output | Prompt engineering (best-effort) | SDK native support |
| MCP | Not supported | Native support |
| Server management | None (library call) | Must manage `opencode serve` lifecycle |

## File Structure

```
packages/providers/src/community/opencode/
├── provider.ts              # OpenCodeProvider class
├── capabilities.ts          # OPENCODE_CAPABILITIES
├── config.ts                # parseOpencodeConfig
├── server-manager.ts        # OpenCode Server lifecycle
├── event-bridge.ts          # SSE Event → MessageChunk
├── registration.ts          # registerOpencodeProvider()
├── index.ts                 # Public exports
├── provider.test.ts         # Tests
└── config.test.ts           # Config tests
```

## Capability Declaration (Honest)

```typescript
export const OPENCODE_CAPABILITIES: ProviderCapabilities = {
  sessionResume: true,    // ✅ OpenCode sessions have IDs
  mcp: true,              // ✅ Native MCP support
  hooks: false,           // ❌ Archon hooks ≠ OpenCode plugins
  skills: true,           // ✅ Via systemPrompt injection
  agents: false,          // ❌ No inline sub-agent definitions
  toolRestrictions: true, // ✅ Via tools whitelist/blacklist
  structuredOutput: true, // ✅ SDK native JSON Schema support
  envInjection: true,     // ✅ Via request options
  costControl: false,     // ❌ No cost limit API
  effortControl: true,    // ✅ Via reasoning effort
  thinkingControl: true,  // ✅ Via reasoning toggle
  fallbackModel: false,   // ❌ No automatic fallback
  sandbox: false,         // ❌ No sandbox support
};
```

## Event Bridge Mapping

| OpenCode Event | Archon MessageChunk |
|----------------|---------------------|
| `message.part.updated` (text delta) | `assistant` |
| `message.part.updated` (reasoning) | `thinking` |
| `message.part.updated` (tool call) | `tool` |
| `message.updated` (assistant complete) | `result` (with tokens) |
| `session.error` | `result` (isError: true) |
| `message.part.updated` (step-finish) | `result` (with cost/tokens) |

## Server Lifecycle

1. On first `sendQuery()`, check if OpenCode Server is running (health check)
2. If not running, spawn `opencode serve --port <port> --hostname <hostname>`
3. Wait for health check to pass (timeout: 30s)
4. Create SDK client connected to the server
5. Server process follows Archon process lifecycle (not detached)

## Configuration

```yaml
# .archon/config.yaml
assistants:
  opencode:
    model: anthropic/claude-sonnet-4
    hostname: 127.0.0.1
    port: 4096
    autoStartServer: true
```

## Cross-Cutting Changes

1. `packages/providers/package.json` - Add `@opencode-ai/sdk` dependency
2. `packages/providers/src/registry.ts` - Add `registerOpencodeProvider()` call
3. `packages/providers/package.json` scripts - Add test command

No changes to:
- `AssistantDefaultsConfig` or `AssistantDefaults` (community provider defaults live behind `[string]` index)
- CLI or server entrypoints (use aggregator pattern)
