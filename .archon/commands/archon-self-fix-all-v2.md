---
description: V2 — Read synthesis.json, fix CRITICAL+HIGH findings, emit fix-report.json
argument-hint: (none — reads $ARTIFACTS_DIR/review/synthesis.json)
---

## CRITICAL — Tool-use enforcement

You MUST use Edit/Write to apply fixes AND Write to persist fix-report.json.
Do NOT describe what fixes you would apply — apply them via tool calls.
Do NOT end your turn having only summarised intended changes; the
re-review loop will fail if fix-report.json is missing.

This command MUST end with the following file Written:
- `$ARTIFACTS_DIR/review/fix-report.json`

If validate passes after edits, you MUST also commit and push via Bash.
Never end with uncommitted changes when fixes have been applied.

If there are zero blocking findings to fix, STILL Write fix-report.json
with `{"results": [], "validate_ok": true, "remaining_blocking": 0}` so
downstream gates have something to read.

---

# Self-Fix All (v2)

You are fixing findings from `$ARTIFACTS_DIR/review/synthesis.json` with full Edit/Write/Bash access. **You produce a structured fix-report.json so the re-review loop can verify your work deterministically.**

## Phase 1: LOAD CONTRACT

```bash
SYNTH=$ARTIFACTS_DIR/review/synthesis.json
test -f "$SYNTH"
jq '.verdict, .blocking_count, (.blocking_findings | length)' "$SYNTH"
```

Read the full file. The fields you act on:
- `blocking_findings[]` — the items you must fix (CRITICAL + HIGH, in-scope only)
- Out-of-scope CRITICAL/HIGH are NOT yours to fix; surface them in fix-report.json as deferred

## Phase 2: PLAN BEFORE FIXING

Before editing any file, write `$ARTIFACTS_DIR/review/fix-plan.md`:
- One section per blocking finding
- For each, state: which file you'll edit, what change you'll make, why this addresses ROOT CAUSE not just SYMPTOM
- If a finding has `confirmation_check: "MANUAL"`, plan how a human would verify

This forces you to think before grepping.

## Phase 3: FIX, ONE FINDING AT A TIME

For each `blocking_finding`:

1. **Read the current file** at the specified line. Confirm the `evidence` snippet still matches; if the code has already changed, mark this finding as `already_fixed` and continue.
2. **Apply the fix** — match `recommended_fix` precisely; do not improvise. If you genuinely think the recommended fix is wrong, mark it as `fix_disputed` with reasoning instead of applying a different fix.
3. **Run the `confirmation_check`** immediately after applying. If it returns 0, the fix is applied. If non-zero, mark `confirmation_failed` and move on (don't keep retrying).
4. **Run type-check** — `bun run type-check` (or the project's equivalent) — to catch breakage from your edit. If type-check fails AND your edit caused it, revert and mark `regressed`.
5. **Do NOT add tests as a side effect** unless the finding category is `headline-untested` / `branch-untested` (in which case adding the test IS the fix).
6. **Do NOT touch files outside the finding's `file` field** unless absolutely required (e.g., the fix is in module A but a downstream type in module B must be updated). Note any such cross-file edits in fix-report.json under `unplanned_edits`.

## Phase 4: REGRESSION GUARD

After all fixes:

```bash
# Run the project's full validate (or fall back)
if jq -e '.scripts.validate' package.json >/dev/null 2>&1; then
  bun run validate
else
  bun run type-check && bun run lint
fi
```

If validate fails, decide: was the failure caused by a fix you applied? If yes, identify which finding's fix broke it, revert just that fix, and mark it `fix_regressed_validation`. Do not commit broken validate.

## Phase 5: EMIT fix-report.json

Write `$ARTIFACTS_DIR/review/fix-report.json`:

```json
{
  "pr_number": <int>,
  "started_blocking_count": <int>,
  "results": [
    {
      "finding_id": "code-review-1",
      "status": "fixed" | "already_fixed" | "fix_disputed" | "confirmation_failed" | "regressed" | "fix_regressed_validation" | "manual_required" | "deferred_out_of_scope",
      "files_changed": ["packages/router/src/engine.ts"],
      "confirmation_exit_code": 0 | <int>,
      "notes": "<one paragraph max — why this status>"
    }
  ],
  "unplanned_edits": [<file paths edited that weren't in any finding>],
  "validate_ok": true | false,
  "remaining_blocking": <int>
}
```

`remaining_blocking` is the count of findings whose status is NOT in (`fixed`, `already_fixed`).

## Phase 6: COMMIT

If at least one fix landed and validate passes:

```bash
set -euo pipefail
git add -A
git commit -m "$(cat <<'EOF'
fix: address review findings (v2 self-fix)

Applied $(jq -r '[.results[] | select(.status == "fixed")] | length' "$ARTIFACTS_DIR/review/fix-report.json") fixes from synthesis.json.
Disputed: $(jq -r '[.results[] | select(.status == "fix_disputed")] | length' "$ARTIFACTS_DIR/review/fix-report.json")
Manual required: $(jq -r '[.results[] | select(.status == "manual_required")] | length' "$ARTIFACTS_DIR/review/fix-report.json")
Remaining blocking: $(jq -r '.remaining_blocking' "$ARTIFACTS_DIR/review/fix-report.json")

See $ARTIFACTS_DIR/review/fix-report.json for the full contract.
EOF
)"
git push
```

If validate fails OR no fixes landed, do NOT commit — surface the state in fix-report.json. The post-fix gate will catch it.

## Success Criteria

- `fix-report.json` exists, every blocking finding has a result
- `validate_ok: true` or an explanation of which fix broke validate
- Statuses don't lie: `"fixed"` requires `confirmation_exit_code == 0`
- No silent files-outside-scope edits — every cross-file change is in `unplanned_edits`
