---
paths:
  - "packages/core/src/db/**/*.ts"
  - "migrations/**/*.sql"
---

# Database Conventions

## 7 Tables (all prefixed `remote_agent_`)

| Table | Purpose |
|-------|---------|
| `remote_agent_conversations` | Platform conversations, soft-delete (`deleted_at`), title, `hidden` flag |
| `remote_agent_sessions` | AI SDK sessions with `parent_session_id` audit chain, `transition_reason` |
| `remote_agent_codebases` | Repository metadata, `commands` JSONB |
| `remote_agent_isolation_environments` | Git worktree tracking, `workflow_type`, `workflow_id` |
| `remote_agent_workflow_runs` | Execution state, `working_path`, `last_activity_at` |
| `remote_agent_workflow_events` | Step-level event log per run |
| `remote_agent_messages` | Conversation history, tool call metadata as JSONB |

## IDatabase Interface

Auto-detects at startup: PostgreSQL if `DATABASE_URL` set, SQLite (`~/.archon/archon.db`) otherwise.

```typescript
import { pool, getDialect } from './connection';  // pool = IDatabase instance

// $1, $2 placeholders work for both PostgreSQL and SQLite
const result = await pool.query<Conversation>(
  'SELECT * FROM remote_agent_conversations WHERE id = $1',
  [id]
);
const row = result.rows[0]; // rows is readonly T[]
```

Use `getDialect()` for dialect-specific expressions: `dialect.generateUuid()`, `dialect.now()`, `dialect.jsonMerge(col, paramIdx)`, `dialect.jsonArrayContains(col, path, paramIdx)`, `dialect.nowMinusDays(paramIdx)`.

## Import Pattern — Namespaced Exports

```typescript
// Use namespace imports for DB modules (consistent project-wide pattern)
import * as conversationDb from '@archon/core/db/conversations';
import * as sessionDb from '@archon/core/db/sessions';
import * as codebaseDb from '@archon/core/db/codebases';
import * as workflowDb from '@archon/core/db/workflows';
import * as messageDb from '@archon/core/db/messages';
```

## INSERT Error Handling

```typescript
try {
  const result = await pool.query('INSERT INTO remote_agent_conversations ...', params);
  return result.rows[0];
} catch (error) {
  log.error({ err: error, params }, 'db_insert_failed');
  throw new Error('Failed to create conversation');
}
```

## UPDATE with rowCount Verification

`updateConversation()` and similar throw `ConversationNotFoundError` / `SessionNotFoundError` when `rowCount === 0`. Callers must handle:

```typescript
try {
  await db.updateConversation(conversationId, { codebase_id: codebaseId });
} catch (error) {
  if (error instanceof ConversationNotFoundError) {
    // Handle missing conversation specifically
  }
  throw error; // Re-throw unexpected errors
}
```

## Session Audit Trail

Sessions are immutable. Every new session links back: `parent_session_id` → previous session, `transition_reason: TransitionTrigger`. Query the chain to understand history. `active = true` means the current session.

## Soft Delete

Conversations use soft-delete: `deleted_at IS NULL` filter should be included in all user-facing queries. `hidden = true` conversations are worker conversations (background workflows) — excluded from UI listings.

## Anti-patterns

- Never `SELECT *` in production queries on large tables — select specific columns
- Never write raw SQL strings in application code outside `packages/core/src/db/` modules
- Never bypass the `IDatabase` interface to call database drivers directly from other packages
- Never assume `rows[0]` exists without null-checking — queries can return empty arrays
- Never use `RETURNING *` in UPDATE when only checking success — check `rowCount` instead
