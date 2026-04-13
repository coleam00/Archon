---
paths:
  - "packages/*/src/**/*.ts"
---

# Logging Conventions

## Structured Logging with Pino

```typescript
import { createLogger } from '@archon/paths';

const log = createLogger('orchestrator');

// Event naming: {domain}.{action}_{state}
// Standard states: _started, _completed, _failed, _validated, _rejected
async function createSession(conversationId: string, codebaseId: string) {
  log.info({ conversationId, codebaseId }, 'session.create_started');

  try {
    const session = await doCreate();
    log.info({ conversationId, codebaseId, sessionId: session.id }, 'session.create_completed');
    return session;
  } catch (e) {
    const err = e as Error;
    log.error(
      { conversationId, error: err.message, errorType: err.constructor.name, err },
      'session.create_failed',
    );
    throw err;
  }
}
```

## Event Naming Rules

- Format: `{domain}.{action}_{state}` — e.g. `workflow.step_started`, `isolation.create_failed`
- Avoid generic events like `processing` or `handling`
- Always pair `_started` with `_completed` or `_failed`
- Include context: IDs, durations, error details

## Log Levels

`fatal` > `error` > `warn` > `info` (default) > `debug` > `trace`

## Verbosity

- CLI: `archon --quiet` (errors only) — suppresses Pino logs and workflow progress output
- CLI: `archon --verbose` (debug) — enables debug Pino logs and tool-level workflow progress events
- Server: `LOG_LEVEL=debug bun run start`

## Never Log

API keys or tokens (mask: `token.slice(0, 8) + '...'`), user message content, PII.
