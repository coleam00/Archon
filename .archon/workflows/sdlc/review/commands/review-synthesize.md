# Synthesize the Review

Aggregate the lens reports into one evidence-based verdict, write the review report humans read, and — when the scope is a PR — publish it there. Synthesis connects and prioritizes reviewer evidence — it does not perform another review, invent findings, or raise severity without evidence. Never modify project files or commit; your only write outside the artifacts directory is the PR comment below.

## Read — the findings reach you complete

1. `$ARTIFACTS_DIR/review/scope.md` — the target, mode, and the **head SHA under review** — and then **the diff itself**, using the commands scope.md records. You verify findings against the code, never against summaries.
2. Every lens report present in `$ARTIFACTS_DIR/review/` (`code.md`, `seams.md`, `tests.md`, `errors.md`, `comments.md`, `types.md`, `docs.md`, `simplify.md`) — read each **in full**. These files are the findings channel and nothing is truncated at this seam; the structured fields you emit at the end are only the loop signal, not the findings.

The lenses ENABLED this round: `code` and `seams` always, plus the optional lenses whose input is true — tests=$INPUTS.tests, errors=$INPUTS.errors, comments=$INPUTS.comments, types=$INPUTS.types, docs=$INPUTS.docs, simplify=$INPUTS.simplify. A missing file for a DISABLED lens is by design — record it as disabled, never as clean. A missing or empty file for an ENABLED lens means that lens **failed to report**: the review is missing evidence it was asked for — record the gap and apply the verdict rule below.

## Aggregate

- Merge duplicate findings across lenses into one **causal** finding; attribute every contributing lens; preserve genuine disagreement rather than averaging it away.
- **Adversarially verify before accepting**: for each Critical or Important finding, check its cited `file:line` evidence yourself (read the file, run the smallest falsifying command when practical). A finding whose evidence does not hold is recorded as rejected with the reason — not silently dropped.
- Assign stable IDs (`R1`, `R2`, …). In light mode, keep the prior report's IDs for the same causal finding, allocate new IDs after the prior maximum, and carry every prior finding forward with its verdict: still open, fixed at `<sha>`, or disproved — **never make an earlier finding disappear**.
- Severity: Critical and Important block; **Suggestions never block, including every simplify finding.**

## Verdict

`ready: true` exactly when there are **no open Critical or Important findings AND every enabled lens delivered its report**. An enabled lens with no report forces `ready: false` with the gap named — a review missing evidence it was asked for can refuse readiness, never certify it. "Nothing left to say" is not the bar — open Suggestions do not hold `ready` back, and a round that ran fewer lenses says so rather than implying a fuller clearance.

## Write the report

Write `$ARTIFACTS_DIR/review/report.md`:

1. **Verdict** — ready or not, and the one-sentence reason.
2. **Reviewed head SHA** — from scope.md, stated exactly (this is the next round's cursor).
3. **Findings** — by severity, each with ID, claim, `file:line` evidence, and the smallest correction; then rejected findings with the disproving evidence; then Suggestions.
4. **Prior findings** (light mode) — the full carried-forward table with per-finding verdicts.
5. **Lens roster** — which lenses ran, were disabled, failed to report, or found nothing. A lens that failed to report gets an explicit directive: it must run **in full** next round, not in delta mode — the next round's reviewers read this report first.

## Post to the PR

When scope.md names a PR: publish the complete report there as **one canonical comment** carrying the marker `<!-- archon-review-report -->` on its first line. Search the PR's existing comments for that marker first — if found, **edit that exact comment in place** (`gh api` / `gh pr comment --edit-last` only when it is the marked one); never append a second report. Then read the comment back and confirm its body matches what you wrote; record its URL in the report. Publication is not done until the read-back agrees. When the scope is the working diff (no PR), skip this section — the artifact report is the deliverable.

## Verify before finishing

Confirm the report exists, every lens file present is accounted for in the roster, the head SHA appears verbatim, every finding you accepted has evidence you actually checked, and — for a PR scope — the canonical comment read-back matched. Then declare:

- `ready` — the verdict as defined above.
- `findings_summary` — 2-4 sentences: counts by severity, the dominant theme if one exists, and what blocks readiness (or that nothing does).
