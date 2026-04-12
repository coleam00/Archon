---
paths:
  - "**/*.test.ts"
  - "**/*.spec.ts"
---

# Testing Conventions

## CRITICAL: mock.module() Pollution Rules

`mock.module()` permanently replaces modules in the **process-wide module cache**. `mock.restore()` does NOT undo it ([oven-sh/bun#7823](https://github.com/oven-sh/bun/issues/7823)).

**Rules:**
1. **Never add `afterAll(() => mock.restore())` for `mock.module()` calls** — it has no effect
2. **Never have two test files `mock.module()` the same path with different implementations in the same `bun test` invocation**
3. **Use `spyOn()` for internal modules** — `spy.mockRestore()` DOES work for spies

```typescript
// CORRECT: spy (restorable)
import * as git from '@archon/git';
const spy = spyOn(git, 'checkout');
spy.mockImplementation(async () => ({ ok: true, value: undefined }));
// afterEach:
spy.mockRestore();

// CORRECT: mock.module() for external deps (not restorable — isolate in separate test file)
mock.module('@slack/bolt', () => ({ App: mock(() => mockApp), LogLevel: { INFO: 'info' } }));
```

## Test Batching Per Package

Each package splits tests into separate `bun test` invocations to prevent pollution:

| Package | Batches |
|---------|---------|
| `@archon/core` | 7 batches (clients, handlers, db+utils, path-validation, cleanup-service, title-generator, workflows, orchestrator) |
| `@archon/workflows` | 5 batches |
| `@archon/adapters` | 3 batches (chat+community+forge-auth, github-adapter, github-context) |
| `@archon/isolation` | 3 batches |

**Never run `bun test` from the repo root** — causes ~135 mock pollution failures. Always use:

```bash
bun run test           # Correct: per-package isolation via bun --filter '*' test
bun run test --watch   # Watch mode (single package)
```

## Mock Pattern for Lazy Loggers

All adapter/db/orchestrator files use lazy logger pattern. Mock before import:

```typescript
// MUST come before import of the module under test
const mockLogger = {
  fatal: mock(() => undefined), error: mock(() => undefined),
  warn: mock(() => undefined),  info: mock(() => undefined),
  debug: mock(() => undefined), trace: mock(() => undefined),
};
mock.module('@archon/paths', () => ({ createLogger: mock(() => mockLogger) }));

import { SlackAdapter } from './adapter'; // Import AFTER mock
```

## Database Test Mocking

```typescript
import { createQueryResult, mockPostgresDialect } from '../test/mocks/database';

const mockQuery = mock(() => Promise.resolve(createQueryResult([])));
mock.module('./connection', () => ({
  pool: { query: mockQuery },
  getDialect: () => mockPostgresDialect,
}));

// In tests:
mockQuery.mockResolvedValueOnce(createQueryResult([existingRow]));
mockQuery.mockClear(); // in beforeEach
```

## Test Structure

```typescript
import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';

describe('ComponentName', () => {
  beforeEach(() => {
    mockFn.mockClear(); // Reset call counts
  });

  test('does thing when condition', async () => {
    mockQuery.mockResolvedValueOnce(createQueryResult([fixture]));
    const result = await functionUnderTest(input);
    expect(result).toEqual(expected);
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});
```

## Anti-patterns

- Never `import` a module before all `mock.module()` calls for its dependencies
- Never use `afterAll(() => mock.restore())` for `mock.module()` — it silently does nothing
- Never test with real database or filesystem in unit tests — always mock
- Never run `bun test` from the repo root
- Never add a new test file with conflicting `mock.module()` to an existing batch — create a new batch in the package's `package.json` test script
