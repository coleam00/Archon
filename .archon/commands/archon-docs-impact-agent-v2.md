---
description: V2 — Review docs impact, emit structured findings.json
argument-hint: (none — reads from $ARTIFACTS_DIR/review/scope.md)
---

## CRITICAL — Tool-use enforcement

You MUST use the Write tool to persist BOTH findings files. Do NOT describe
findings as a chat response — invoke Write. The pipeline blocks if either
file is missing.

This command MUST end with BOTH files Written:
- `$ARTIFACTS_DIR/review/docs-impact-findings.md`
- `$ARTIFACTS_DIR/review/docs-impact-findings.json`

Even if you found zero issues, Write the JSON with empty findings array.

---

# Docs-Impact Review Agent (v2)

Edit tool is denied (no source modifications); Write and Bash are allowed.
Confirms the diff doesn't drift docs out of sync with code.

## Phase 1: LOAD

```bash
PR_NUMBER=$(cat $ARTIFACTS_DIR/.pr-number)
cat $ARTIFACTS_DIR/review/scope.md
gh pr diff $PR_NUMBER
# Discover doc locations
ls README.md CHANGELOG.md docs/ packages/docs-web/ 2>/dev/null
```

## Phase 2: ANALYZE

For every change in the diff, check:
- **Public API additions/removals/renames** — exported functions, classes, types, REST routes, MCP tools, CLI commands, slash commands, env vars, config keys
- **Schema enum changes** — e.g., `data.status` enum drift from `'down'` → `'unavailable'`. CLAUDE.md or docs that document the old enum become bugs the moment this PR lands.
- **Behaviour changes that contradict existing docs** — README says "X always returns Y", PR makes it sometimes return Z
- **CLAUDE.md drift** — the project rule changed; CLAUDE.md still says the old rule
- **CHANGELOG missing entry** — for user-facing change, no entry under [Unreleased]
- **Removed feature still referenced** — README/docs mention a feature this PR deleted

## Phase 3: EMIT

Markdown plus JSON:

```json
{
  "agent": "docs-impact",
  "pr_number": <int>,
  "verdict": "APPROVE" | "REQUEST_CHANGES" | "NEEDS_DISCUSSION",
  "findings": [
    {
      "id": "docs-impact-1",
      "severity": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
      "category": "api-undocumented" | "enum-drift" | "behavior-contradiction" | "claude-md-drift" | "changelog-missing" | "removed-feature-still-referenced",
      "title": "...",
      "file": "<doc file that's now wrong>",
      "line": <int>,
      "evidence": "<the now-incorrect doc text + the code that contradicts it>",
      "why_it_matters": "<reader will be misled>",
      "recommended_fix": "<exact replacement text>",
      "confirmation_check": "<bash, e.g. `grep -q 'unavailable' CLAUDE.md`>",
      "in_scope": true | false
    }
  ],
  "stats": { "critical": <int>, "high": <int>, "medium": <int>, "low": <int> }
}
```

**Severity rubric**:
- **CRITICAL** — public API doc lies about behaviour; enum drift in a contract that other systems consume
- **HIGH** — CLAUDE.md drift on a rule the team relies on
- **MEDIUM** — CHANGELOG missing for user-facing change
- **LOW** — could add a docs entry

## Phase 4: VALIDATE

```bash
jq -e '.agent == "docs-impact" and (.findings | type == "array")' $ARTIFACTS_DIR/review/docs-impact-findings.json
```

## Success Criteria

- Diff has been compared against README, CHANGELOG, CLAUDE.md, and docs/ contents
- Every finding cites the doc file that's now wrong AND the code that contradicts it
- `recommended_fix` is the actual text that should replace the wrong doc text
