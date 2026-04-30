---
description: V2 — Review comment quality, emit structured findings.json
argument-hint: (none — reads from $ARTIFACTS_DIR/review/scope.md)
---

# Comment-Quality Review Agent (v2)

READ-ONLY agent. The most common finding in this category is AI-style verbose comments that re-narrate the diff. Be strict.

## Phase 1: LOAD

```bash
PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number)
cat $ARTIFACTS_DIR/review/scope.md
gh pr diff $PR_NUMBER
cat CLAUDE.md  # the project's comment policy lives here
```

## Phase 2: ANALYZE

CLAUDE.md often says "default to writing no comments — only add them when the WHY is non-obvious." Apply that lens. Look for:

- **Comments that explain WHAT the code does** — well-named identifiers should already do that
- **Diff narration** — paragraph-long comments that retell what the diff changed (e.g., "Declaration emitter doesn't narrow…", "Sentinel rationale…"). The diff already shows what changed; the comment will rot the moment someone refactors.
- **Task-bound references** — "used by X flow", "added for Y issue", "handles the case from #123". This belongs in the PR description, not the code.
- **Comments that lie** — comment claims one thing, code does another (especially after a fix where the comment wasn't updated)
- **TS workaround monuments** — long comments preserving an apology for a type cast (e.g. "Declaration emit narrowing gap"). The right fix is to refactor the type, not preserve the cast and apologise for it.
- **Test comments that admit non-coverage** — a test comment saying "this is a structural test, the code has X in finally" is a flag the test isn't really testing X
- **Commented-out code** — should be deleted; git remembers
- **Missing WHY where it would be valuable** — a non-obvious invariant or workaround for a known bug that has no comment

## Phase 3: EMIT

Markdown plus JSON. Schema:

```json
{
  "agent": "comment-quality",
  "pr_number": <int>,
  "verdict": "APPROVE" | "REQUEST_CHANGES" | "NEEDS_DISCUSSION",
  "findings": [
    {
      "id": "comment-quality-1",
      "severity": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
      "category": "narration" | "task-reference" | "lying" | "ts-monument" | "test-theatre-comment" | "commented-out-code" | "missing-why",
      "title": "...",
      "file": "...",
      "line": <int>,
      "evidence": "<exact comment text>",
      "why_it_matters": "...",
      "recommended_fix": "DELETE" | "REWRITE_AS_WHY" | "MOVE_TO_PR_DESCRIPTION" | "<specific replacement>",
      "confirmation_check": "<bash, e.g. `! grep -F 'narration text' path/to/file.ts`>",
      "in_scope": true | false
    }
  ],
  "stats": { "critical": <int>, "high": <int>, "medium": <int>, "low": <int> }
}
```

**Severity rubric**:
- **CRITICAL** — comment lies about behaviour (will mislead a maintainer)
- **HIGH** — TS workaround monument that should be a refactor; test comment that admits the test doesn't test the thing
- **MEDIUM** — narration; task-reference comments
- **LOW** — could add a WHY for clarity

## Phase 4: VALIDATE

```bash
jq -e '.agent == "comment-quality" and (.findings | type == "array")' $ARTIFACTS_DIR/review/comment-quality-findings.json
```

## Success Criteria

- Findings are about WHY-vs-WHAT and rot-resistance, not about presence/absence of JSDoc
- Every finding references the exact comment text in `evidence`
- `recommended_fix` is one of the canonical actions or a specific replacement
