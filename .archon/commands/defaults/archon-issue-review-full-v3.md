---
description: Full fix+review pipeline for a GitHub issue — auto-fixes EVERY severity (CRITICAL/HIGH/MEDIUM/LOW), not just high+medium. Use when you want every reviewer finding addressed, including nits.
argument-hint: <issue-number>
---

# Issue Review Full — v3 (fix every single one)

**Input**: $ARGUMENTS

**This is the v3 variant of `archon-issue-review-full`.** The default (`archon-issue-review-full`) auto-fixes CRITICAL + HIGH findings only. v3 widens the auto-fix list to include **MEDIUM and LOW** as well — every finding the reviewers produced is fixed, not just the high-impact ones. The merge-gate verdict rule is unchanged: a CRITICAL finding still BLOCKs the merge, HIGH triggers "APPROVE_WITH_FIXES", and pure LOW is fine to merge after auto-fix.

If you want the default behaviour, use `archon-issue-review-full` instead.

## Trigger this when

- "fix every single one" / "fix all severities" / "fix the nits too"
- You want a clean PR where reviewer feedback is fully addressed, including style/LOW items
- You're okay with the higher token spend (LOW findings can be 2–3x the per-PR cost)

## Do NOT trigger this when

- You want fast feedback (v2/v3 review loops take similar time, but v3 has more post-fix work)
- The PR is from an external contributor and you'd rather they review the nits themselves (v2's conservatism is sometimes correct)
- You're prototyping and don't want every LOW finding fixed

---

## How this dispatches

This command maps to the workflow `archon-issue-review-full-v3` (defined in `.archon/workflows/defaults/archon-issue-review-full-v3.yaml`). The workflow is identical to `archon-issue-review-full` except the `synthesize` node is `archon-synthesize-review-v3` instead of `-v2`.

The v3 synthesizer:
- Reads the same reviewer JSONs from `$ARTIFACTS_DIR/review/*-findings.json`
- Widens `blocking_findings` from `(CRITICAL, HIGH)` to `(CRITICAL, HIGH, MEDIUM, LOW)`
- Marks the synthesis JSON with `v3_widened_to_all_severities: true` so downstream consumers can identify v3 output
- Groups the human-readable synthesis.md by severity (CRITICAL → LOW) so reviewers see high-impact items first

The downstream `archon-implement-review-fixes` step reads `blocking_findings` from the synthesis, so it will pick up the wider list automatically. No v3-specific fix command is needed.

---

## Your Mission

Run the full v3 pipeline on the issue number passed in `$ARGUMENTS`:

1. **Investigate** the issue (load context, do root-cause analysis, write plan to artifact)
2. **Implement** the fix (code changes, tests, commit on a branch)
3. **Verify PR base** matches `$BASE_BRANCH`, retarget if not
4. **Scope the review** to what's in the diff
5. **Sync with main** (rebase or merge to keep diff readable)
6. **Run 5 parallel reviewers** (code-review, error-handling, test-coverage, comment-quality, docs-impact)
7. **Synthesize (v3)** — aggregate findings, widen blocking list to all severities, write synthesis.json + synthesis.md
8. **Implement fixes** — apply every blocking finding (now includes LOW)
9. **Summarise** — final decision matrix with all severities surfaced

**Golden Rule**: The v3 contract is "fix everything the reviewers found". Don't second-guess LOW findings unless they're clearly wrong (e.g., contradicts the user's stated intent) — in that case, mark `fix_disputed` rather than silently dropping them.

---

## Phase 1: DISPATCH

Dispatch the v3 workflow:

```
archon_run workflow=archon-issue-review-full-v3 argument="<issue-number-from-arguments>"
```

The workflow is self-contained — it will spin up a worktree, run all 5 reviewers in parallel, synthesize v3, and apply every fix.

## Phase 2: MONITOR

Use `archon_status` and `archon_logs` to watch progress. Expected milestones:
- `synthesize` completes → check `$ARTIFACTS_DIR/review/synthesis.json` for `v3_widened_to_all_severities: true` (sanity check that v3 actually ran)
- `implement-fixes` runs longer than the v2 equivalent (LOW findings are most of the volume)
- `summary` → final report

## Phase 3: VERIFY

After the run completes, verify:
- `fix-report.json` shows `remaining_blocking: 0` (all severities were attempted)
- The PR has a commit titled like `fix: address review findings (v3 self-fix)` (or v2's equivalent for cross-author PRs)
- `gh pr view --json files` shows edits consistent with the synthesis (LOWs may have produced many small file changes)

If `fix-report.json` shows `fix_disputed` or `confirmation_failed` items, surface them to the user — those are the LOWs the agent declined to fix.

---

## Reverting to default behaviour

To dispatch the standard "CRITICAL+HIGH only" pipeline, use `archon-issue-review-full` (no v3 suffix). The default command is unmodified.

## Notes for the user

If you want a per-issue opt-in flag (e.g., `--all-severities` on the original command), that's a workflow-level change — the synthesis node's command would need to read a parameter and dispatch v2 or v3 accordingly. For now, v3 is a separate dispatch.
