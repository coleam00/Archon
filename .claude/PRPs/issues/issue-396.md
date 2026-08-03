# Investigation: Test adapter improvements — store user messages, fix response format

**Issue**: #396 (https://github.com/dynamous-community/remote-coding-agent/issues/396)
**Type**: ENHANCEMENT
**Investigated**: 2026-02-17T12:00:00Z

### Assessment

| Metric     | Value  | Reasoning                                                                                          |
| ---------- | ------ | -------------------------------------------------------------------------------------------------- |
| Priority   | MEDIUM | Impacts DX for e2e testing but workarounds exist (reading adapter internals or using database)      |
| Complexity | LOW    | 2 files changed, isolated to test adapter and its endpoint — no cross-cutting concerns              |
| Confidence | HIGH   | Clear code path, user messages already stored internally, just not exposed by the GET endpoint      |

---

## Problem Statement

The test adapter's `GET /test/messages/:conversationId` endpoint only returns server-sent messages (`direction: "sent"`), making it impossible to reconstruct full conversation flow from test output alone. Additionally, the response format duplicates `conversationId` at both the outer wrapper and inside each message object.

---

## Analysis

### Root Cause / Change Rationale

The GET endpoint calls `testAdapter.getSentMessages()` which explicitly filters to `direction === 'sent'`. User messages ARE already stored via `receiveMessage()` with `direction: 'received'` — they're just not exposed.

The redundant `conversationId` is because the `TestMessage` interface includes `conversationId` as a field, and the endpoint wraps the array in another object with the same key.

### Evidence Chain

WHY: GET /test/messages only shows server messages
↓ BECAUSE: Endpoint calls `getSentMessages()` not `getMessages()`
Evidence: `packages/server/src/index.ts:370` - `const messages = testAdapter.getSentMessages(conversationId);`

↓ BECAUSE: `getSentMessages()` filters to `direction === 'sent'`
Evidence: `packages/server/src/adapters/test.ts:91-93` - `return this.getMessages(conversationId).filter(m => m.direction === 'sent');`

↓ ROOT CAUSE: Endpoint uses wrong accessor — `getMessages()` already returns all messages
Evidence: `packages/server/src/adapters/test.ts:87-89` - returns all messages without filtering

WHY: `conversationId` duplicated in response
↓ BECAUSE: `TestMessage` interface includes `conversationId` field (line 16)
↓ AND: Endpoint wraps in `{ conversationId, messages }` (line 371)
↓ ROOT CAUSE: Each message carries `conversationId` which is redundant when grouped under that key

### Affected Files

| File                                              | Lines  | Action | Description                                        |
| ------------------------------------------------- | ------ | ------ | -------------------------------------------------- |
| `packages/server/src/index.ts`                    | 368-372| UPDATE | Change GET endpoint to use `getMessages()` and strip inner `conversationId` |
| `packages/server/src/adapters/test.ts`            | 15-20  | UPDATE | Remove `conversationId` from `TestMessage` interface |
| `packages/server/src/adapters/test.ts`            | 26-39  | UPDATE | Stop storing `conversationId` in each message      |
| `packages/server/src/adapters/test.ts`            | 73-84  | UPDATE | Stop storing `conversationId` in each message      |
| `packages/server/src/adapters/test.test.ts`       | varies | UPDATE | Update assertions to reflect new message shape     |

### Integration Points

- `packages/server/src/index.ts:370` — the GET endpoint is the only consumer of `getSentMessages()`
- `packages/server/src/index.ts:356` — POST endpoint calls `receiveMessage()` (stores user msgs already)
- `packages/server/src/adapters/test.test.ts` — unit tests assert on `conversationId` field in messages
- No external consumers — test adapter is purely for local testing

### Git History

- **Introduced**: `41415d7e` - 2025-11-10 - Cole Medin - original test adapter
- **Last modified**: `c7cd67e` - 2026-01-30 - Pino logging migration
- **Implication**: Original design oversight — user messages were stored but never exposed in the API

---

## Implementation Plan

### Step 1: Remove `conversationId` from `TestMessage` interface

**File**: `packages/server/src/adapters/test.ts`
**Lines**: 15-20
**Action**: UPDATE

**Current code:**
```typescript
interface TestMessage {
  conversationId: string;
  message: string;
  timestamp: Date;
  direction: 'sent' | 'received';
}
```

**Required change:**
```typescript
interface TestMessage {
  message: string;
  timestamp: Date;
  direction: 'sent' | 'received';
}
```

**Why**: `conversationId` is redundant — messages are stored in a `Map<string, TestMessage[]>` keyed by conversationId. The outer response already includes it.

---

### Step 2: Update `sendMessage()` to not include `conversationId`

**File**: `packages/server/src/adapters/test.ts`
**Lines**: 34-39
**Action**: UPDATE

**Current code:**
```typescript
    msgs.push({
      conversationId,
      message,
      timestamp: new Date(),
      direction: 'sent',
    });
```

**Required change:**
```typescript
    msgs.push({
      message,
      timestamp: new Date(),
      direction: 'sent',
    });
```

---

### Step 3: Update `receiveMessage()` to not include `conversationId`

**File**: `packages/server/src/adapters/test.ts`
**Lines**: 79-84
**Action**: UPDATE

**Current code:**
```typescript
    msgs.push({
      conversationId,
      message,
      timestamp: new Date(),
      direction: 'received',
    });
```

**Required change:**
```typescript
    msgs.push({
      message,
      timestamp: new Date(),
      direction: 'received',
    });
```

---

### Step 4: Change GET endpoint to return all messages

**File**: `packages/server/src/index.ts`
**Lines**: 368-372
**Action**: UPDATE

**Current code:**
```typescript
  app.get('/test/messages/:conversationId', c => {
    const conversationId = c.req.param('conversationId');
    const messages = testAdapter.getSentMessages(conversationId);
    return c.json({ conversationId, messages });
  });
```

**Required change:**
```typescript
  app.get('/test/messages/:conversationId', c => {
    const conversationId = c.req.param('conversationId');
    const messages = testAdapter.getMessages(conversationId);
    return c.json({ conversationId, messages });
  });
```

**Why**: `getMessages()` returns all messages (both sent and received) in chronological order. The `direction` field on each message distinguishes them.

---

### Step 5: Update unit tests

**File**: `packages/server/src/adapters/test.test.ts`
**Action**: UPDATE

Remove `conversationId` from `toMatchObject` assertions in `sendMessage` and `receiveMessage` tests.

**Current (line 16-20):**
```typescript
      expect(messages[0]).toMatchObject({
        conversationId: 'conv-123',
        message: 'Hello, world!',
        direction: 'sent',
      });
```

**Required change:**
```typescript
      expect(messages[0]).toMatchObject({
        message: 'Hello, world!',
        direction: 'sent',
      });
```

Similarly for `receiveMessage` test (line 49-53):
```typescript
      expect(messages[0]).toMatchObject({
        message: 'User input',
        direction: 'received',
      });
```

---

## Patterns to Follow

**From codebase — the `getMessages()` method already exists and returns all messages:**

```typescript
// SOURCE: packages/server/src/adapters/test.ts:87-89
getMessages(conversationId: string): TestMessage[] {
  return this.messages.get(conversationId) ?? [];
}
```

**Web API pattern — returns flat message list (no nested wrapper):**

```typescript
// SOURCE: packages/server/src/routes/api.ts:182-188
const messages = await messageDb.listMessages(conv.id, limit);
return c.json(
  messages.map(m => ({
    ...m,
    metadata: typeof m.metadata === 'string' ? m.metadata : JSON.stringify(m.metadata),
  }))
);
```

---

## Edge Cases & Risks

| Risk/Edge Case                       | Mitigation                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------- |
| Breaking existing test scripts       | `direction` field preserved — consumers can still filter by sent/received  |
| `getSentMessages()` becomes unused   | Keep it — still useful for callers who only want server responses           |
| Response shape change                | Outer `{ conversationId, messages }` stays; only inner messages lose redundant field |

---

## Validation

### Automated Checks

```bash
bun run type-check
bun test packages/server/src/adapters/test.test.ts
bun run lint
```

### Manual Verification

1. Start server: `bun run dev:server`
2. Send a message: `curl -X POST http://localhost:3090/test/message -H "Content-Type: application/json" -d '{"conversationId":"test","message":"/status"}'`
3. Get messages: `curl http://localhost:3090/test/messages/test`
4. Verify response includes both `direction: "received"` and `direction: "sent"` messages
5. Verify no `conversationId` inside individual message objects

---

## Scope Boundaries

**IN SCOPE:**
- Remove `conversationId` from `TestMessage` interface
- Change GET endpoint to return all messages via `getMessages()`
- Update unit tests

**OUT OF SCOPE (do not touch):**
- `getSentMessages()` method — keep for backward compat, still useful
- Database message persistence (web adapter concern)
- POST endpoint behavior
- Other adapters

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-02-17
- **Artifact**: `.claude/PRPs/issues/issue-396.md`
