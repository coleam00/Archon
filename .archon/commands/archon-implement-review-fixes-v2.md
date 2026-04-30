---
description: V2 — Apply review fixes from synthesis.json (used by archon-comprehensive-pr-review-v2)
argument-hint: (none — reads $ARTIFACTS_DIR/review/synthesis.json)
---

# Implement Review Fixes (v2)

This is the comprehensive-pr-review-v2 counterpart of `archon-self-fix-all-v2`. The contract and protocol are identical — read [archon-self-fix-all-v2](archon-self-fix-all-v2.md) for the full spec.

The difference is intent:
- `archon-self-fix-all-v2` is invoked at the tail of `archon-fix-github-issue-v2` after a PR has just been created by Archon itself
- `archon-implement-review-fixes-v2` is invoked from `archon-comprehensive-pr-review-v2` against a PR that may have been authored by anyone (human or another agent)

Same protocol applies. Read `synthesis.json`, plan, fix one finding at a time, run `confirmation_check` after each, run validate at the end, emit `fix-report.json`, commit only if validate passes.

## Specific notes for cross-author PRs

When the PR was authored by a human:
- **Be conservative.** Apply ONLY the recommended_fix from the finding. Don't refactor adjacent code, don't reformat, don't update unrelated files.
- **Surface, don't suppress.** If a finding seems wrong or the human's intent is unclear, mark `fix_disputed` and let the human resolve it. Don't second-guess.
- **Preserve commit attribution.** Write your commit message clearly — the human didn't write these changes, and downstream `git blame` should reflect that.

When the PR was authored by an earlier Archon run:
- Treat it the same as `archon-self-fix-all-v2`. Apply fixes more freely; the original "author" is also a tool.

## Schema

Same as `archon-self-fix-all-v2`. Output `$ARTIFACTS_DIR/review/fix-report.json` with the schema documented there.

## Success Criteria

Same as `archon-self-fix-all-v2`. The post-fix gate in the workflow YAML will read `fix-report.json` and the subsequent `re-review.json` to decide whether the PR can leave draft state.
