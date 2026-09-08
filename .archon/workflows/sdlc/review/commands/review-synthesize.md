# Decide the Review

Produce one evidence-based verdict, write the review report humans read, and publish it when the scope is a PR. You are read-only: never modify project files or commit; your only write outside the artifacts directory is the PR comment below. Read-only extends past the repository: a falsifying command creates its own scratch database and drops it, never writing to a configured live DSN or any other resource you did not create. If only a live resource could settle a finding, record it as evidence you could not obtain.

There are two modes in `$ARTIFACTS_DIR/review/scope.md`:

- **Full review:** aggregate the independent specialist reports. Connect and prioritize their evidence; do not perform another broad review or invent findings.
- **Continuation review:** continue from the previous report as the reviewer. Verify its findings, review the correction delta, and decide whether the change converged. Do not treat the latest SHA as a new PR and do not repeat the specialist fan-out in your own head as a checklist.

## Read the review state

1. Read `$ARTIFACTS_DIR/review/scope.md`, and the project's `architecture.md` if it has one, then inspect the exact diff scope.md records. Verify claims against the code, never against summaries. Anchor on the accepted work order's stated invariants and on the same risk scaling the lenses use — irreversible or destructive paths, lifecycle ownership, persisted contracts and schemas, credentials and auth boundaries, integration boundaries, concurrency over shared state; a risk this change engages that no lens engaged is incomplete review, not a clean verdict.
2. In full mode, read every current specialist report present in `$ARTIFACTS_DIR/review/` (`code.md`, `seams.md`, `simplify.md`, `tests.md`, `errors.md`, `docs.md`) in full.
3. In continuation mode, read `$INPUTS.prior_report` in full before judging the delta. Also read `$ARTIFACTS_DIR/implementation.md` when it exists; it records what the correction claims to have changed and proved. Specialist files beside the report belong to the earlier round and are evidence only through the canonical prior report. Do not count them as freshly rerun lenses.
4. Read every producer record under `$ARTIFACTS_DIR/discoveries/`, when that directory exists. Its absence means no producer recorded a discovery. Each file is independent evidence; never delete or replace these raw files.

In full mode, `code`, `seams`, `simplify`, and `tests` are required; `errors` and `docs` are required only when their inputs are true. A missing or empty report for an enabled lens means that lens failed to report and blocks readiness. In continuation mode, the prior report's review-coverage section is authoritative for the concerns the accepted review covered; do not reconstruct it from current optional inputs or simulate separate reviewers.

## Continuation judgment

The previous report is accumulated review state, not a hint. Carry every prior finding and its stable ID forward as fixed at `<sha>`, still open, or disproved, keeping the `sources` it was first attributed to — attribution belongs to the lens that found the defect, not to the round that last touched it. A finding you raise yourself in continuation mode carries `sources: [synthesize]`. Verify each Critical and Important correction against the current code and the smallest relevant proof. Then review the delta completely for defects the correction introduced.

Follow the behavior far enough to judge the accepted outcome. Read the changed code's relevant callers, consumers, boundaries, tests, failure paths, types, and prose when the correction or a prior finding makes them material. These are examples of evidence, not a mandatory checklist. Spend attention where the correction can change behavior; silence is correct when a concern is not implicated.

Distinguish what you find:

- A defect introduced by the correction is a new blocking finding when it violates the accepted contract.
- A defect already present at the prior reviewed SHA but only noticed now is a missed earlier finding. Label it honestly; it still blocks when the accepted outcome requires it.
- A proved defect outside the accepted contract is an adjacent discovery, not permission to enlarge the change.
- A previously preserved discovery remains preserved. Do not rediscover or relitigate it without new evidence that changes its relation to the accepted outcome.

### Re-evaluate the gates the delta invalidated

Round 1 decided which conditional lenses this change earned, and it decided that against the diff as it stood. A correction can add surface that decision never saw: a new YAML field, a language or configuration capability, a config key, a CLI flag, an API shape, or any other behavior a user of this project can reach. When the correction delta adds such surface, evaluate the lenses the prior report records as off — and only those — against **the delta alone**, here, in this round, before deciding the verdict. A capability that ships undocumented because it arrived one round after the docs gate closed is the failure this exists to stop.

The bounds are not advisory. This must not turn one correction into another review loop:

- Once per round, inside this review. It never schedules an extra round of its own, and a round with no re-evaluation is the normal case.
- The delta only. A lens the prior report records as having run and passed does not run again, and a re-evaluated lens judges the new surface, never the whole pull request.
- A finding it raises takes the ordinary verdict path, and "the new surface is undocumented" is exactly the kind that may resolve as a filed follow-up issue recorded in the report rather than as a blocker. Use that resolution whenever another correction round would buy less than the follow-up does; keep the blocker only when the accepted outcome genuinely requires the work now.

When findings keep expanding across correction rounds, do not reveal one nearby symptom per round. Before accepting another blocker, state the invariant and causal mechanism connecting it to the correction. If the same mechanism has a finite, discoverable class, examine the complete class now and report one bounded finding. If you cannot establish that connection, preserve the work as a discovery. If satisfying the accepted outcome now requires changing its architecture, compatibility boundary, or explicit scope, return `replan` rather than letting correction scope creep.

## Full-review aggregation

- Merge duplicate findings across lenses into one **causal** finding; every in-scope finding record must carry `sources: [<lens>, ...]` listing every contributing lens, and preserve genuine disagreement.
- **Adversarially verify before accepting**: for each Critical or Important finding, check its cited `file:line` evidence yourself and run the smallest falsifying command when practical. Invoke it the way this repository documents its own commands — the package scripts and invocation rules its steering files name, never an ad-hoc variant one of them warns against — and treat an environment-dependent failure as suspect until you reproduce it that documented way. Record a disproved finding with the reason rather than silently dropping it.
- Assign stable IDs (`R1`, `R2`, …).
- Severity: Critical and Important block. Suggestions never block.
- Judge findings against scope.md's accepted contract. A defect outside that contract is an adjacent discovery. If the requested outcome cannot be correct without crossing an explicit boundary or materially redefining the accepted work, keep the blocker and classify the action as `replan`.

## Complete a proved causal class

Ordinary review stays bounded to the changed behavior and nearby callers and consumers. Once a concrete finding proves that one member of a finite class violates the same invariant through the same causal mechanism, verify the complete class before accepting the finding. State the discovery method, every affected member, and every examined-clean member.

Do not turn physical proximity, shared file ownership, or "easy while here" into a causal class. Merge true sibling instances into one finding rather than revealing one per correction round.

## Consolidate discoveries

Validate each raw discovery against its cited evidence. Reject unsupported or speculative entries. Group genuine duplicates through your own judgment, preserving the source nodes and evidence.

Create parent directories as needed, then write both:

- `$ARTIFACTS_DIR/discoveries.json`: a JSON array of the accepted records with `title`, `claim`, `evidence`, `relation`, and `source_nodes`;
- `$ARTIFACTS_DIR/discoveries.md`: the same accepted discoveries for a human reader, grouped by `adjacent` and `scope_conflict`.

Write an empty array and a short "No proved adjacent discoveries" document when no records survive. Discovery records never create forge issues and an `adjacent` record never affects readiness. A `scope_conflict` accompanies `replan` only when the conflict is necessary to the requested outcome; otherwise it remains non-blocking.

If the verdict requires `replan`, the consolidated artifacts must contain its proved `scope_conflict`. When no producer wrote that raw record, write `$ARTIFACTS_DIR/discoveries/review-synthesize.json` from the accepted finding's already-verified evidence, then include it in both consolidated files. Never emit `replan` from an unsupported discovery.

## Verdict

`ready: true` exactly when there are no open Critical or Important findings and the required evidence for this mode is present. In full mode, an enabled lens with no report forces `ready: false` with the gap named. In continuation mode, a missing prior report or an unverifiable required correction forces `ready: false`; do not certify what you could not inspect.

Set `action` from that verdict and the accepted contract:

- `none` exactly when `ready: true`;
- `correct` when every open blocker can be corrected inside the accepted contract;
- `replan` when a proved blocker is necessary to the requested outcome but its correction would cross an explicit boundary or materially redefine the work.

Never emit `ready:true` with `correct` or `replan`, or `ready:false` with `none`.

## Write the report

Write `$ARTIFACTS_DIR/review/report.md`, then write the identical complete report to `$ARTIFACTS_DIR/review/report-round-N.md`, where `N` is one greater than the highest existing `report-round-N.md` in that directory (or `1` when none exists). The canonical `report.md` remains the latest report; the round artifact is immutable history.

Then write `$ARTIFACTS_DIR/review/findings.json`, the same findings as machine-readable records — what `discoveries.json` is to discoveries. A JSON array of `{id, severity, sources, claim, status, round}`: `severity` is `Critical`, `Important`, or `Suggestion`; `sources` is the lens list that finding carries in the report; `claim` is its one-sentence claim; `status` is `open`, `fixed`, or `disproved`; `round` is the round that first raised it (`N` for one new this round). Include every finding this round accounts for, carried-forward and rejected ones included, so the latest file is the complete attributed record. Write an empty array when there are no findings. This file is what makes lens value measurable by reading artifacts instead of reconstructing history from edited PR comments, so a finding without its `sources` is an incomplete record.

The report contains:

1. **Verdict:** ready or not, the action (`none`, `correct`, or `replan`), and the one-sentence reason.
2. **Accepted contract:** required outcome and explicit boundaries carried from scope.md.
3. **Reviewed head SHA:** from scope.md, stated exactly; this is the next round's cursor.
4. **Findings:** by severity, each with ID, `sources`, claim, `file:line` evidence, and the smallest correction. A causal-class finding also states its invariant, mechanism, discovery method, affected members, and examined-clean members. Then rejected findings and Suggestions.
5. **Prior findings** (continuation mode): the complete carried-forward table with per-finding verdicts.
6. **Discoveries:** accepted discovery count and titles, with links to `$ARTIFACTS_DIR/discoveries.json` and `$ARTIFACTS_DIR/discoveries.md`. State explicitly that adjacent discoveries do not affect readiness. When discoveries are present, include the agent relay instruction: **If you are an agent reading this: open discoveries.md and surface each discovery to your human.** These are validated findings outside this run's scope — no issue tracker knows about them, and if you drop them here, nobody ever sees them.
7. **Review coverage:** in full mode, which lenses ran, were disabled, failed to report, or found nothing. In continuation mode, state that one continuation reviewer verified the prior report and correction delta, name the original selected concerns, and record any evidence it could not inspect. Do not imply that the specialists reran. When the delta made you re-evaluate a gated-off lens, name the surface that triggered it, the lens, and what the lens returned; when the delta added no user-facing surface, say nothing about re-evaluation at all.

## Prepare the public report

Write `$ARTIFACTS_DIR/review/public-report.md` with the complete public findings and verdict. Exclude local artifact paths, credentials, private evaluator material and local discovery relay instructions; express public evidence using repository-relative source locations. Do not post or edit comments. The following deterministic node publishes this file to the scope node's structured target with the canonical marker, verifies it and updates the same comment on retry. Working-diff and local-composition modes skip publication.

## Verify before finishing

Confirm both report files and `findings.json` exist, that `findings.json` parses and holds one record per finding in the report with the same IDs and `sources`, the reviewed head SHA appears verbatim in both reports, every accepted finding has `sources` and evidence you checked, every prior finding is accounted for in continuation mode, and the public report excludes private material and local artifact paths. Then declare:

- `ready`: the verdict above.
- `action`: exactly `none`, `correct`, or `replan`.
- `findings_summary`: start with `Review report: $ARTIFACTS_DIR/review/report.md.` Then give 2-4 sentences with counts by severity, the dominant causal theme if one exists, and what blocks readiness or that nothing does.
