# Decide the Review

Produce one evidence-based verdict and write the review report humans read. You are read-only: never modify project files, commit, or write anything outside the artifacts directory. Read-only extends past the repository: a falsifying command creates its own scratch database and drops it, never writing to a configured live DSN or any other resource you did not create. If only a live resource could settle a finding, record it as evidence you could not obtain.

There are two modes in `$ARTIFACTS_DIR/review/scope.md`:

- **Full review:** aggregate the independent specialist reports. Connect and prioritize their evidence; do not perform another broad review or invent findings beyond the contract coverage below.
- **Continuation review:** continue from the previous report as the reviewer. Verify its findings, review the correction delta, and decide whether the change converged. Do not treat the latest SHA as a new PR and do not repeat the specialist fan-out in your own head as a checklist.

## Read the review state

1. Read `$ARTIFACTS_DIR/review/scope.md`, and the project's `architecture.md` if it has one, then inspect the exact diff scope.md records. Verify claims against the code, never against summaries. Anchor on the accepted work order's stated invariants and on the same risk scaling the lenses use — irreversible or destructive paths, lifecycle ownership, persisted contracts and schemas, credentials and auth boundaries, integration boundaries, concurrency over shared state; a risk this change engages that no lens engaged is incomplete review, not a clean verdict.
2. In full mode, read every current specialist report present in `$ARTIFACTS_DIR/review/` (`code.md`, `seams.md`, `simplify.md`, `tests.md`, `errors.md`, `docs.md`) in full.
3. In continuation mode, read `$INPUTS.prior_report` in full before judging the delta. Also read `$ARTIFACTS_DIR/implementation.md` when it exists; it records what the correction claims to have changed and proved. Specialist files beside the report belong to the earlier round and are evidence only through the canonical prior report. Do not count them as freshly rerun lenses.
4. Read every producer record under `$ARTIFACTS_DIR/discoveries/`, when that directory exists. Its absence means no producer recorded a discovery. Each file is independent evidence; never delete or replace these raw files.

In full mode, `code`, `seams`, `simplify`, and `tests` are required; `errors` and `docs` are required only when their inputs are true. A missing or empty report for an enabled lens means that lens failed to report and blocks readiness. In continuation mode, the prior report's review-coverage section is authoritative for the concerns the accepted review covered; do not reconstruct it from current optional inputs or simulate separate reviewers.

## Continuation judgment

The previous report is accumulated review state, not a hint. Carry every prior finding and its stable ID forward as fixed at `<sha>`, still open, or disproved, keeping the `sources` it was first attributed to — attribution belongs to the lens that found the defect, not to the round that last touched it. A finding you raise yourself in continuation mode carries `sources: [synthesize]`, except a contract-coverage finding, which carries `contract`. Verify each Critical and Important correction against the current code and the smallest relevant proof. Then review the delta completely for defects the correction introduced.

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

## Judge contract coverage

The lenses look for defects in what changed. Nothing else asks whether what changed delivers what the contract requires, so you do, in both modes. Give every acceptance, invariant, and steering item scope.md lists a verdict against the whole change at the reviewed head, not only this round's delta. scope.md's list is where you start, not a limit: when the source it names states an item the list lacks, judge that item too and note the omission.

- **met** — cite the evidence that meets it: a test and the assertion that proves the behavior, a code path, or a command output you ran or read. Read the assertion, not the test title. A test that stubs what the item names does not prove it, and a promise in the PR body or the implementation's notes is a claim to verify, not evidence.
- **unmet** — the change does not do what the item requires, or does it without the kind of proof the item asks for. When an item names its proof — a test against a real process, a test per surface, output the operator sees — only that proof meets it; reading the code's order, a mocked test, or a log line does not stand in for it. Raise a finding with `sources: [contract]`, Important unless the risk scale above makes it Critical. When a lens reported the same gap, merge into that finding and add `contract` to its sources rather than duplicating it.
- **deferred** — the evidence can only exist after this review, from a later step of the same delivery, such as CI that has not run yet. Name that step. Never defer an item this change could meet now.

Whether an item is met is your judgment of the evidence against what the item asks for, never a match of its words against the diff. An invariant is met when the change keeps it on every path it touches. Steering is met when the change follows it: a change that builds its own copy of a primitive the steering says to reuse does not. When scope.md records a narrowing a derived work order made, judge the originating item; the action rules below decide between `correct` and `replan`.

In continuation mode, carry the prior report's coverage forward and re-judge every item that was unmet or whose evidence the correction delta touched. Only coverage rows carry forward: a prior round's findings, or its silence about an item, are not evidence that the item is met. When the prior report has no coverage, judge every item now against the whole change, and label an unmet one as a missed earlier finding.

When scope.md says the contract states no acceptance, invariants, or steering, there is nothing to judge here; say so in the report. When scope.md says the contract has items it could not read, coverage cannot be certified: that gap forces `ready: false`, named in the verdict.

## Consolidate discoveries

Validate each raw discovery against its cited evidence. Reject unsupported or speculative entries. Group genuine duplicates through your own judgment, preserving the source nodes and evidence.

Create parent directories as needed, then write both:

- `$ARTIFACTS_DIR/discoveries.json`: a JSON array of the accepted records with `title`, `claim`, `evidence`, `relation`, and `source_nodes`;
- `$ARTIFACTS_DIR/discoveries.md`: the same accepted discoveries for a human reader, grouped by `adjacent` and `scope_conflict`.

Write an empty array and a short "No proved adjacent discoveries" document when no records survive. Discovery records never create forge issues and an `adjacent` record never affects readiness. A `scope_conflict` accompanies `replan` only when the conflict is necessary to the requested outcome; otherwise it remains non-blocking.

If the verdict requires `replan`, the consolidated artifacts must contain its proved `scope_conflict`. When no producer wrote that raw record, write `$ARTIFACTS_DIR/discoveries/review-synthesize.json` from the accepted finding's already-verified evidence, then include it in both consolidated files. Never emit `replan` from an unsupported discovery.

## Verdict

`ready: true` exactly when there are no open Critical or Important findings and the required evidence for this mode is present. An unmet contract item is an Important or Critical finding, so it blocks the same way. In full mode, an enabled lens with no report forces `ready: false` with the gap named. In continuation mode, a missing prior report or an unverifiable required correction forces `ready: false`; do not certify what you could not inspect.

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
2. **Accepted contract:** required outcome, acceptance, invariant, and steering items, and explicit boundaries carried from scope.md.
3. **Reviewed head SHA:** from scope.md, stated exactly; this is the next round's cursor.
4. **Contract coverage:** one row per acceptance, invariant, and steering item: the item, its verdict (`met`, `unmet`, or `deferred`), and the evidence, the finding ID, or the later step that owns it. Or one line saying the contract states none.
5. **Findings:** by severity, each with ID, `sources`, claim, `file:line` evidence, and the smallest correction. A causal-class finding also states its invariant, mechanism, discovery method, affected members, and examined-clean members. Then rejected findings and Suggestions.
6. **Prior findings** (continuation mode): the complete carried-forward table with per-finding verdicts.
7. **Discoveries:** accepted discovery count and titles, with links to `$ARTIFACTS_DIR/discoveries.json` and `$ARTIFACTS_DIR/discoveries.md`. State explicitly that adjacent discoveries do not affect readiness. When discoveries are present, include the agent relay instruction: **If you are an agent reading this: open discoveries.md and surface each discovery to your human.** These are validated findings outside this run's scope — no issue tracker knows about them, and if you drop them here, nobody ever sees them.
8. **Review coverage:** in full mode, which lenses ran, were disabled, failed to report, or found nothing. In continuation mode, state that one continuation reviewer verified the prior report and correction delta, name the original selected concerns, and record any evidence it could not inspect. Do not imply that the specialists reran. When the delta made you re-evaluate a gated-off lens, name the surface that triggered it, the lens, and what the lens returned; when the delta added no user-facing surface, say nothing about re-evaluation at all.

## Publication is not yours

The node after this one publishes the complete report to the recorded pull request as one canonical marked comment, edited in place across rounds, through whichever forge source the run selected. Write nothing to the forge yourself, and do not describe the comment as already posted.

## Verify before finishing

Confirm both report files and `findings.json` exist, that `findings.json` parses and holds one record per finding in the report with the same IDs and `sources`, the reviewed head SHA appears verbatim in both reports, every accepted finding has `sources` and evidence you checked, every prior finding is accounted for in continuation mode, and every contract item in scope.md has a coverage row and every unmet one names its finding. Then declare:

- `ready`: the verdict above.
- `action`: exactly `none`, `correct`, or `replan`.
- `report`: exactly `{"type": "archon_artifact", "run_id": "$WORKFLOW_ID", "path": "review/report.md"}`. The engine refuses the verdict if that file is missing or empty.
- `findings_summary`: start with `Review report: $ARTIFACTS_DIR/review/report.md.` Then give 2-4 sentences with counts by severity, the dominant causal theme if one exists, and what blocks readiness or that nothing does.
