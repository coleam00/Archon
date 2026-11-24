# Settle the Review and End the Round

Synthesis decided a verdict and wrote the report. When that verdict was not ready, three independent verifiers judged its open blocking findings. Apply their votes, decide how this review ends, publish the report on the pull request, and declare the result the next stage starts from. You judge no finding again yourself: the votes and synthesis's labels decide.

Read `$ARTIFACTS_DIR/review/report.md`, `$ARTIFACTS_DIR/review/findings.json` and synthesis's verdict:

$synthesize.output

The commit under review is `$scope.output.head`, and the pull request it belongs to is `$scope.output.pr` (`null` for a working diff). `$scope.output.head_matches` says whether the pull request's head is still that commit.

## Apply the votes

When synthesis's verdict was ready, there are no votes: skip to the next section. Otherwise read each `$ARTIFACTS_DIR/review/verify-<n>.json` that exists (n is 1, 2 and 3). Each is a JSON array of `{ id, real, belongs, reason }`. A verifier that failed, wrote no file, or skipped a finding casts no vote on it, and no vote upholds: a missing verifier never turns a blocker into a note.

- A blocking finding is demoted only when at least two verifiers voted against it: two that say it is not `real`, or two that say it does not `belong`. A finding whose `sources` include `contract` is never demoted.
- A demoted finding becomes a note: `disproved` when two votes say it is not real; a pre-existing defect when two votes say it is real but outside the change, which you add to the discoveries, so it is relayed rather than dropped; otherwise an open note.
- Record the demotion in `findings.json` (the record becomes `severity: note` and gains `verify`: the votes as written), and put a short verification section at the top of `report.md` and its round copy, naming each demoted finding and the votes, so the report says why its verdict differs from synthesis's text below it.
- Decide readiness again from these facts alone: the verdict is ready when no blocking finding stays open and synthesis declared no coverage gap (`coverage_gaps`). Otherwise the action is the most severe of the remaining open blockers' own `action`s (`ask` over `replan` over `correct`) and of what the coverage gaps need: synthesis's action when it is more severe than any blocker it saw, which only a gap explains; otherwise `correct`.

## Decide how the review ends

When `$INPUTS.issue` is empty, this review was started by hand on a pull request, not by delivery: end `ready` when the verdict is ready and `not_ready` otherwise. Nothing starts after it, and you leave no ask.

Otherwise, in delivery:

- **approve** — the verdict is ready. The host stage starts on the change.
- **return** — the action is `correct`: the change goes back to its builder with this report. Before you return it, read `rounds.md` (`.archon/sdlc/policy/`, over the default in `$PACK_DIR/.shared/policy/`): the binding is `build-after-review`. When its limit is used up, end `ask` instead, with the options `one-more-round` (the builder fixes what this report returned once more), `take-as-is`, `replan` and `stop` (below).
- **replan** — the action is `replan`: the item goes back to planning with this report.
- **ask** — the action is `ask`. Leave each decision synthesis named as an ask, written as `asks.md` says. Its options are fixed, because the answer's option starts the next stage: `send-back` (the builder continues with the operator's answer and this report), `take-as-is` (the change goes on to the host stage as it is), `replan` (the item goes back to planning with the answer) and `stop` (nothing more runs; an operator lands or closes the change by hand). Write the decision itself, and what each option means for it, in `context`. Recommend the one you would take, or `null` with why you cannot choose.

## Publish the report

Publish when the target is a pull request and `$scope.output.head_matches` is true; otherwise publish nothing and say why in `findings_summary`. Write the comment body to `$ARTIFACTS_DIR/review/comment.md` with your file-writing tool: the line `<!-- archon-review-report -->`, then `Reviewed commit: \`<the full commit under review>\``, then `Verdict: ready` or `Verdict: not ready`, then `Contract: complete` when `contract_left` is empty or `Contract: open` otherwise, then a blank line and the whole of `report.md`. Before you write it, read the pull request's head again with `pr.view`; when it is no longer the commit under review, publish nothing and say so. Then write the request `{"subject":{"kind":"pr","ref":<ref>},"marker":"<!-- archon-review-report -->","body":<the file's text>}` to `$ARTIFACTS_DIR/review/comment.json` and pass it with `--data-file` to `workitem.comment.upsert`, through the Archon CLI whose argv is the JSON string array in `$ARCHON_CLI_COMMAND`. The forge keeps one comment per marker, so every round edits the same comment. A failed write is reported in `findings_summary`, never repeated through another tool; the verdict stands either way.

## Declare

- `outcome` — `approve`, `return`, `replan` or `ask` in delivery; `ready` or `not_ready` for a review by hand.
- `ready` — the verdict after the votes.
- `action` — `none`, `correct`, `replan` or `ask`, after the votes; `none` exactly when `ready` is true.
- `head` — the commit under review, in full.
- `pull_request` — the URL of the pull request reviewed; the empty string for a working diff.
- `published` — true when the comment was written.
- `findings_summary` — start with `Review report: <the absolute path of report.md>.` Then two to four sentences with blocking and note counts after the votes, what blocks readiness or that nothing does, and whether the report was published.
- `report` — the absolute path of `$ARTIFACTS_DIR/review/report.md`. The next review round, the builder and the host read it there.
- `discoveries` — synthesis's accepted discovery records, plus each pre-existing defect the votes demoted.
- `contract_left` — synthesis's list, unchanged.
- `asks` — with `ask`, each decision as above; otherwise empty.
