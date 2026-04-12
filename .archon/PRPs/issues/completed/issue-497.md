# Investigation: output_format produces mixed prose+JSON, breaking condition evaluation

**Issue**: #497 (https://github.com/dynamous-community/remote-coding-agent/issues/497)
**Type**: BUG
**Investigated**: 2026-03-10T12:00:00Z

### Assessment

| Metric     | Value    | Reasoning                                                                                                    |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| Severity   | HIGH     | Any DAG workflow using `output_format` + `when:` conditions is broken — conditional nodes silently skip       |
| Complexity | MEDIUM   | 3 files to change (claude.ts, dag-executor.ts, condition-evaluator.ts) + tests, well-understood data flow     |
| Confidence | HIGH     | Root cause is clear: SDK's `structured_output` field is never read, prose gets concatenated into node output  |

---

## Problem Statement

When a DAG node uses `output_format` (JSON Schema) with the Claude Code SDK, the node output contains reasoning prose prepended to the structured JSON. `executeNodeInternal` concatenates all `assistant` text chunks unconditionally. Downstream `when:` conditions using `$nodeId.output.field` call `JSON.parse()` on the mixed content, which fails, causing all conditional nodes to be silently skipped.

---

## Analysis

### Root Cause

The Claude Code SDK provides structured output via **two channels**:
1. `assistant` message text blocks — includes reasoning prose AND the JSON output
2. `result` message's `structured_output` field — contains only the validated JSON

`ClaudeClient.sendQuery` never reads `structured_output` from the `result` message (line 300-311 only extracts `session_id` and `usage`). `WorkflowMessageChunk` has no field to carry structured output. `executeNodeInternal` concatenates all assistant text indiscriminately.

### Evidence Chain

WHY: `when:` conditions like `$classify.output.run_code_review == 'true'` evaluate to false
↓ BECAUSE: `resolveOutputRef` calls `JSON.parse()` on node output that starts with prose
Evidence: `packages/workflows/src/condition-evaluator.ts:38` — `JSON.parse(nodeOutput.output)` fails

↓ BECAUSE: `nodeOutput.output` contains `"I'll analyze the PR...\n{\"run_code_review\": \"true\"}"`
Evidence: `packages/workflows/src/dag-executor.ts:652` — `nodeOutputText += msg.content` for every assistant chunk

↓ BECAUSE: Claude SDK emits reasoning prose as `assistant` text blocks before the JSON block
Evidence: `packages/core/src/clients/claude.ts:290-292` — yields every `text` block as `{ type: 'assistant' }`

↓ ROOT CAUSE: The SDK's `structured_output` field on `SDKResultSuccess` is never read
Evidence: `packages/core/src/clients/claude.ts:300-311` — only `session_id` and `usage` extracted from result
Evidence: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:1556` — `structured_output?: unknown` exists but is unused

### Affected Files

| File                                                  | Lines     | Action | Description                                                              |
| ----------------------------------------------------- | --------- | ------ | ------------------------------------------------------------------------ |
| `packages/workflows/src/deps.ts`                      | 28        | UPDATE | Add `structuredOutput` to `WorkflowMessageChunk` result variant          |
| `packages/core/src/clients/claude.ts`                 | 300-311   | UPDATE | Extract `structured_output` from SDK result and forward it               |
| `packages/workflows/src/dag-executor.ts`              | 637-710   | UPDATE | Use `structuredOutput` from result message to override `nodeOutputText`  |
| `packages/workflows/src/dag-executor.test.ts`         | NEW       | UPDATE | Add tests for structured output extraction in `executeNodeInternal`      |
| `packages/workflows/src/condition-evaluator.test.ts`  | NEW       | UPDATE | Add test for mixed prose+JSON scenario                                   |

### Integration Points

- `ClaudeClient.sendQuery` (`packages/core/src/clients/claude.ts:284-312`) — yields `WorkflowMessageChunk` to all callers
- `executeNodeInternal` (`packages/workflows/src/dag-executor.ts:539`) — consumes chunks, builds `NodeOutput`
- `substituteNodeOutputRefs` (`packages/workflows/src/dag-executor.ts:325`) — reads `NodeOutput.output` for prompt substitution
- `resolveOutputRef` (`packages/workflows/src/condition-evaluator.ts:26`) — reads `NodeOutput.output` for condition evaluation
- `executor.ts` sequential/loop executor — also consumes `WorkflowMessageChunk` but does not use `output_format`

### Git History

- **DAG engine introduced**: `a315617` — feat: DAG workflow engine with parallel execution and conditional branching (#450)
- **output_format wiring**: `4204e1f` — Archon orchestrator (#452)
- **Implication**: `structured_output` was never read from the start — the bug existed from initial implementation

---

## Implementation Plan

### Step 1: Add `structuredOutput` to `WorkflowMessageChunk` result variant

**File**: `packages/workflows/src/deps.ts`
**Lines**: 28
**Action**: UPDATE

**Current code:**
```typescript
| { type: 'result'; sessionId?: string; tokens?: WorkflowTokenUsage }
```

**Required change:**
```typescript
| { type: 'result'; sessionId?: string; tokens?: WorkflowTokenUsage; structuredOutput?: unknown }
```

**Why**: The `WorkflowMessageChunk` type needs to carry structured output from the SDK through to the DAG executor.

---

### Step 2: Extract `structured_output` from SDK result in `ClaudeClient`

**File**: `packages/core/src/clients/claude.ts`
**Lines**: 300-311
**Action**: UPDATE

**Current code:**
```typescript
} else if (msg.type === 'result') {
    const resultMsg = msg as {
      session_id?: string;
      usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
    };
    const tokens = normalizeClaudeUsage(resultMsg.usage);
    yield {
      type: 'result',
      sessionId: resultMsg.session_id,
      ...(tokens ? { tokens } : {}),
    };
  }
```

**Required change:**
```typescript
} else if (msg.type === 'result') {
    const resultMsg = msg as {
      session_id?: string;
      usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number };
      structured_output?: unknown;
    };
    const tokens = normalizeClaudeUsage(resultMsg.usage);
    yield {
      type: 'result',
      sessionId: resultMsg.session_id,
      ...(tokens ? { tokens } : {}),
      ...(resultMsg.structured_output !== undefined
        ? { structuredOutput: resultMsg.structured_output }
        : {}),
    };
  }
```

**Why**: Forward the SDK's `structured_output` field through the `WorkflowMessageChunk` pipeline.

---

### Step 3: Use `structuredOutput` to override `nodeOutputText` in DAG executor

**File**: `packages/workflows/src/dag-executor.ts`
**Lines**: 637-710 (inside `executeNodeInternal`)
**Action**: UPDATE

In the message processing loop, capture `structuredOutput` from the result message. After the loop, if `structuredOutput` is available and the node has `output_format`, use the JSON-stringified structured output as the node's output instead of the concatenated text.

**Current code (result handling around line 660-666):**
```typescript
} else if (msg.type === 'result') {
    if (msg.sessionId) newSessionId = msg.sessionId;
    if (msg.tokens) nodeTokens = msg.tokens;
}
```

**Required change:**
```typescript
} else if (msg.type === 'result') {
    if (msg.sessionId) newSessionId = msg.sessionId;
    if (msg.tokens) nodeTokens = msg.tokens;
    if (msg.structuredOutput !== undefined) structuredOutput = msg.structuredOutput;
}
```

Add variable declaration near `nodeOutputText`:
```typescript
let structuredOutput: unknown;
```

After the loop completes (before the return at ~line 706), override `nodeOutputText` when structured output is available:
```typescript
// When output_format is set and the SDK returned structured_output,
// use it instead of the concatenated assistant text (which includes prose)
if (structuredOutput !== undefined && nodeOptions?.outputFormat) {
  nodeOutputText = typeof structuredOutput === 'string'
    ? structuredOutput
    : JSON.stringify(structuredOutput);
}
```

**Why**: This is the minimal fix — it uses the SDK's dedicated structured output field (which contains only the validated JSON) to replace the mixed prose+JSON concatenation. The prose is still streamed to the user for visibility, but the node's stored output is clean JSON for downstream conditions.

---

### Step 4: Add tests for structured output extraction

**File**: `packages/workflows/src/dag-executor.test.ts`
**Action**: UPDATE

**Test cases to add:**

```typescript
describe('executeNodeInternal with output_format', () => {
  it('uses structuredOutput from result when output_format is set', async () => {
    // Mock AI client that yields prose + JSON as assistant chunks,
    // then a result with structuredOutput
    const mockClient = {
      *sendQuery() {
        yield { type: 'assistant', content: 'Let me analyze...\n' };
        yield { type: 'assistant', content: '{"type": "BUG"}' };
        yield { type: 'result', sessionId: 'sid', structuredOutput: { type: 'BUG' } };
      },
    };
    // ... execute node with output_format set ...
    // Assert: output is '{"type":"BUG"}' (from structuredOutput), not 'Let me analyze...\n{"type":"BUG"}'
  });

  it('falls back to concatenated text when structuredOutput is absent', async () => {
    // Mock AI client without structuredOutput on result
    // Assert: output is the full concatenated text (backward compatible)
  });
});
```

**File**: `packages/workflows/src/condition-evaluator.test.ts`
**Action**: UPDATE

```typescript
it('dot notation works with clean structured output (not prose+JSON)', () => {
  // Simulates the fixed behavior where output is clean JSON
  const outputs = new Map([['classify', makeOutput(JSON.stringify({ run_code_review: 'true' }))]]);
  expect(evaluateCondition("$classify.output.run_code_review == 'true'", outputs).result).toBe(true);
});
```

---

### Step 5: Verify `substituteNodeOutputRefs` benefits from the fix

**File**: `packages/workflows/src/dag-executor.ts`
**Lines**: 325-350
**Action**: NO CHANGE NEEDED

**Why**: `substituteNodeOutputRefs` reads from `NodeOutput.output`, which will now contain clean JSON when `output_format` is set (thanks to Step 3). No changes needed to the substitution function itself.

---

## Patterns to Follow

**From codebase — mirror these exactly:**

```typescript
// SOURCE: packages/core/src/clients/claude.ts:244-247
// Pattern for conditionally spreading SDK fields into yield
...(requestOptions?.outputFormat !== undefined
  ? { outputFormat: requestOptions.outputFormat }
  : {}),
```

```typescript
// SOURCE: packages/workflows/src/dag-executor.ts:652
// Pattern for accumulating output — we keep this for streaming but override final value
nodeOutputText += msg.content; // ALWAYS capture for $node_id.output
```

---

## Edge Cases & Risks

| Risk/Edge Case                                        | Mitigation                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------- |
| SDK doesn't populate `structured_output`              | Fallback: keep `nodeOutputText` as-is (backward compatible)                     |
| `structured_output` is already a string               | Handle both string and object: stringify only if not already a string            |
| `structured_output` is `null`                         | Check `!== undefined` specifically (null is valid JSON)                          |
| Non-Claude providers (Codex) with `output_format`     | Codex already skips `output_format` with a warning; no impact                   |
| Sequential/loop executor also receives result chunks  | They don't use `output_format` or `nodeOutputText`; no impact                   |
| Prose is still streamed to user (desired behavior)    | `nodeOutputText` accumulation continues for streaming; only final value swapped  |

---

## Validation

### Automated Checks

```bash
bun run type-check
bun run test
bun run lint
```

Or all at once:
```bash
bun run validate
```

### Manual Verification

1. Run the `archon-smart-pr-review` workflow with a test PR — verify the `classify` node produces clean JSON in its output and downstream `when:` conditions evaluate correctly
2. Run a DAG workflow WITHOUT `output_format` — verify no regression in normal text output
3. Check logs for absence of `condition_json_parse_failed` warnings

---

## Scope Boundaries

**IN SCOPE:**
- Forward `structured_output` from Claude SDK result through `WorkflowMessageChunk`
- Override `nodeOutputText` with structured output when available and `output_format` is set
- Add tests for the new behavior

**OUT OF SCOPE (do not touch):**
- `substituteNodeOutputRefs` and `resolveOutputRef` JSON parsing logic (they work fine with clean JSON)
- Codex client or other non-Claude providers
- Sequential/loop executor output handling
- Workflow loader validation of `output_format` schema structure
- Any fallback JSON extraction from mixed text (unnecessary with the proper SDK field)

---

## Metadata

- **Investigated by**: Claude
- **Timestamp**: 2026-03-10T12:00:00Z
- **Artifact**: `.claude/PRPs/issues/issue-497.md`
