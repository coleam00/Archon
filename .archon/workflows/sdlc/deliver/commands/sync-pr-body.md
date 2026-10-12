# Sync the PR description with the final diff

Bring the pull request description back in line with the code after correction
rounds changed it. The description was written when the draft PR opened;
corrections since then may have falsified specific claims in it. Your product is
an accurate PR body — nothing else.

**Read-only everywhere:** never modify files, commit, push, change the PR's
draft state, touch the canonical review comment, or write to the pull request.
The node after this one owns the edit and verifies it.

The target is the run-owned PR, never the current branch's ambient PR mapping:

$INPUTS.pr

Its current description was read from the forge and written to
**$INPUTS.current_body**. Confirm the recorded head branch equals the
checked-out branch before judging anything.

1. Read that body file and the full final diff against the recorded base
   (`git fetch origin <base>`, then `git diff origin/<base>...HEAD`; a local
   `<base>` branch can lag the pull request's base).
2. Check every concrete claim in the body against the final diff: named
   functions and guards, described mechanics, file lists, "unchanged" claims.
   The Problem section describes the issue and rarely drifts; the Solution and
   review-guidance sections are where correction rounds falsify claims.
3. Change only what the diff falsifies. Preserve the body's structure, tone, and
   every claim that is still accurate. Do not rewrite from scratch, do not add
   sections, and do not narrate the correction history or this sync.
4. When nothing is falsified, change nothing.
   One exception to "add no sections": the gates record red they let through as
   typed artifacts. Read the typed-artifact listing at `$TYPED_ARTIFACTS_FILE`,
   take its `artifactsByType["green-gate"]` entries in the order the engine
   recorded them, and open each entry's `path` relative to `$ARTIFACTS_DIR`; any
   with a non-empty `red_cause` that the body does not already disclose gets that
   disclosure — its `stage`, `red_cause`, and `summary`. Surface every listing
   `errors` entry and every gate body you cannot read as a caveat, never as "no
   gates". A correction round or the project gate can go red after the body was
   written, and a reviewer must not have to discover that from a red badge.

Before finishing, re-read your intended final body once against the diff: every
mechanism it describes must be one the diff actually contains.

## Record the intent

When nothing needed changing, write `$ARTIFACTS_DIR/pr-body-intent.json` as
`{"change": false}`.

Otherwise write the **complete** intended body — not a patch — to
`$ARTIFACTS_DIR/pr-body-final.md`, then write
`$ARTIFACTS_DIR/pr-body-intent.json` as
`{"change": true, "bodyPath": "$ARTIFACTS_DIR/pr-body-final.md"}`.

Return only `{"intent": "$ARTIFACTS_DIR/pr-body-intent.json"}`, and report in
your own words which claims you corrected, or that the body was already accurate.
