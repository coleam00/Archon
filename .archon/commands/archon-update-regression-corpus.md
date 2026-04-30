---
description: Stage a patch appending this PR's confirmation_checks to .archon/regression-corpus.json
argument-hint: (none — reads $ARTIFACTS_DIR/review/synthesis.json + .archon/regression-corpus.json)
---

# Update Regression Corpus

After this Archon PR has produced its self-fix (and optionally been merged), append the **blocking findings' confirmation_checks** as new persistent assertions to `.archon/regression-corpus.json` so future PRs cannot regress what this PR fixed.

This node runs **before merge** — it stages the corpus patch as a separate commit on the same branch. Once merged, the corpus grows. If the PR is abandoned, the corpus stays unchanged.

## Phase 1: LOAD

```bash
SYNTH="$ARTIFACTS_DIR/review/synthesis.json"
CORPUS=".archon/regression-corpus.json"

# If no corpus exists in this repo, log and exit cleanly
if [ ! -f "$CORPUS" ]; then
  echo "No corpus in this repo — nothing to update. Bootstrap with the runner if you want one."
  exit 0
fi

# If synthesis.json is missing, this run has no findings to contribute
if [ ! -f "$SYNTH" ]; then
  echo "No synthesis.json — nothing to append"
  exit 0
fi
```

## Phase 2: EXTRACT new assertions from blocking findings

Read each blocking finding from synthesis.json that has a deterministic `confirmation_check` (not `MANUAL`). For each, build a corpus assertion:

```json
{
  "id": "<derived from finding category + issue number>",
  "from_pr": <this PR number>,
  "from_issue": <issue number — extract from PR body's `Closes #N`>,
  "added_at": "<today's date YYYY-MM-DD>",
  "what": "<one-line summary; reuse finding's `title`>",
  "check": "<finding's confirmation_check>",
  "must_pass": true,
  "notes": "Auto-added by archon-update-regression-corpus from PR #<N>"
}
```

Skip findings where `confirmation_check == "MANUAL"`.

## Phase 3: DEDUPE

For each new assertion, check whether an existing corpus entry already has the same `id` or the same `check` string. If so, skip — don't duplicate.

```bash
EXISTING_IDS=$(jq -r '.assertions[].id' "$CORPUS")
EXISTING_CHECKS=$(jq -r '.assertions[].check' "$CORPUS")
```

## Phase 4: STAGE the patch

Write the updated corpus to a new branch commit. Do NOT modify the corpus on the PR branch itself unless the PR is being merged this run — keep the corpus update isolated:

```bash
# Update the JSON file in place
jq --argjson new_assertions "$NEW_ASSERTIONS_JSON" \
  '.assertions += $new_assertions' \
  "$CORPUS" > "$CORPUS.tmp" && mv "$CORPUS.tmp" "$CORPUS"

# Validate the result is still well-formed JSON
jq empty "$CORPUS"

# Stage as a separate commit on the current branch
git add "$CORPUS"
git commit -m "$(cat <<EOF
chore(corpus): add $(echo "$NEW_ASSERTIONS_JSON" | jq 'length') assertion(s) from PR #$(cat "$ARTIFACTS_DIR/.pr-number")

Locks in fix for issue #$ISSUE_NUM via:
$(echo "$NEW_ASSERTIONS_JSON" | jq -r '.[].id | "- " + .')

Future PRs that regress these will fail the regression-corpus CI job.

Co-Authored-By: Archon
EOF
)"
git push
```

## Phase 5: WRITE summary

Write `$ARTIFACTS_DIR/corpus-update.md`:
- How many new assertions were added (or 0 if none)
- Their IDs
- Note: corpus update only takes effect once the PR is merged

If 0 assertions were added (all findings were `MANUAL` or duplicates), still write a summary explaining why so the report node has something to mention.

## Success Criteria

- Corpus file is still well-formed JSON after the update (`jq empty` passes)
- Every new assertion has a deterministic `check` (no `MANUAL` slipped through)
- New assertions don't duplicate existing IDs or check strings
- A separate `chore(corpus):` commit exists on the branch (or, if 0 added, no commit)
- `$ARTIFACTS_DIR/corpus-update.md` describes what changed
