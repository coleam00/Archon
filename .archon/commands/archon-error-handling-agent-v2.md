---
description: V2 — Review error handling, emit structured findings.json
argument-hint: (none — reads from $ARTIFACTS_DIR/review/scope.md)
---

## CRITICAL — Tool-use enforcement

You MUST use the Write tool to persist BOTH findings files. Do NOT describe
findings as a chat response — invoke Write. The pipeline blocks if either
file is missing.

This command MUST end with BOTH files Written:
- `$ARTIFACTS_DIR/review/error-handling-findings.md`
- `$ARTIFACTS_DIR/review/error-handling-findings.json`

Even if you found zero issues, Write the JSON with empty findings array.

---

# Error-Handling Review Agent (v2)

Edit tool is denied (no source modifications); Write and Bash are allowed.
Produce both markdown and JSON artifacts. The pipeline reads the JSON.

## Phase 1: LOAD

```bash
PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number)
cat $ARTIFACTS_DIR/review/scope.md
gh pr diff $PR_NUMBER
```

## Phase 2: ANALYZE

Look for:
- **Swallowed errors** — `catch (e) {}`, `catch (e) { /* ignore */ }`, `.catch(() => {})`, `.catch(() => null)`
- **Generic catches that mask bugs** — `catch (e: any)` followed by no instanceof check, just logging
- **Inappropriate fallbacks** — silently degrading when caller expects failure (e.g., returning `{success: true, results: []}` when upstream is unreachable)
- **Missing error paths** — try blocks where the catch never re-throws and never sets a degraded state
- **Mixed timeout / connection-refused handling** — `AbortError` and `ECONNREFUSED` both treated as "ok, return empty"
- **Body-read silent swallow** — `resp.text().catch(() => '')`
- **Re-thrown but loses context** — `catch (e) { throw new Error('failed') }` (drops original error)
- **Promise rejection without await** — fire-and-forget that loses errors
- **Validation at the wrong boundary** — internal functions re-validating data the boundary already validated, or boundary functions trusting data they shouldn't

## Phase 3: EMIT

Write both:
- `$ARTIFACTS_DIR/review/error-handling-findings.md` (human-readable, free-form)
- `$ARTIFACTS_DIR/review/error-handling-findings.json` (the v2 contract):

```json
{
  "agent": "error-handling",
  "pr_number": <int>,
  "verdict": "APPROVE" | "REQUEST_CHANGES" | "NEEDS_DISCUSSION",
  "findings": [
    {
      "id": "error-handling-1",
      "severity": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
      "category": "swallowed-error" | "silent-fallback" | "missing-error-path" | "lost-context" | "promise-rejection" | "validation-boundary",
      "title": "...",
      "file": "...",
      "line": <int>,
      "evidence": "<exact code snippet>",
      "why_it_matters": "<concrete failure mode this enables>",
      "recommended_fix": "<what to change>",
      "confirmation_check": "<bash command returning 0 when fix applied>",
      "in_scope": true | false
    }
  ],
  "stats": { "critical": <int>, "high": <int>, "medium": <int>, "low": <int> }
}
```

**Severity rubric**:
- **CRITICAL** — silent fallback that masks an upstream outage from the caller (the contract is "tell me when you're down")
- **HIGH** — swallowed error in a code path real users hit; lost error context that breaks debugging
- **MEDIUM** — generic catch where a specific instanceof check belongs
- **LOW** — could re-throw with more context

`confirmation_check` examples for this category:
- `! grep -nE "catch\s*\([^)]*\)\s*\{\s*\}" path/to/file.ts`  (no empty catches)
- `grep -q "throw new UpstreamUnavailableError" path/to/file.ts`  (the specific error type is now thrown)

## Phase 4: VALIDATE

```bash
jq -e '.agent == "error-handling" and (.findings | type == "array")' $ARTIFACTS_DIR/review/error-handling-findings.json
```

## Success Criteria

- JSON artifact exists, parses, agent matches
- Every finding has a deterministic `confirmation_check` or explicit `"MANUAL"`
- Severity assigned per the rubric (don't inflate or deflate)
