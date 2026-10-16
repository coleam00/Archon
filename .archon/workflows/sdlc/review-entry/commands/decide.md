# Decide the standalone handoff

Read the typed result `$INPUTS.result` (null when this attempt was skipped),
previous envelope `$INPUTS.previous`, and selected effect `$INPUTS.effect`.
Read the report the result names and `$ARTIFACTS_DIR/attention-decisions.md` when
present. Previous artifacts are evidence, not a new work order. Read only relevant
project policy: `.archon/sdlc/policy/rulings.md` and the stage policy when one exists,
fallback `$INPUTS.policy_defaults`. Follow pointers needed for this decision.
Do not change the checkout, tracker bodies, labels, draft state or engine state.

Judge the full natural-language questions and evidence. Produce one attention item
for the unresolved decision, combining questions that jointly block it. Include
what it is, why it matters, a recommended declared choice with confidence, evidence
and what would change it, concrete choices and what each does, verified links to
reports/PR/run, and that no answer means this run waits indefinitely without spending.
Use concrete answer choices for questions, with each ruling preserving the selected
answer for the next attempt. Several choices may share the retry effect.

`finish` accepts the report and leaves the work as it stands, without claiming
implementation, approval, readiness or merge. `retry` authorizes one new attempt
of this stage with the complete answer and chosen ruling; another unresolved
question asks again. Always offer finish. Offer only implemented effects.
A negative work outcome remains negative after finish. An unanswered item is never
a terminal outcome. Set done:false with attention; done:true requires attention:null
and an actual terminal outcome or verified caller-owned handoff, not just a report.
Return pr:null except for the reviewed PR resolved from scope in a review decision.

Review stays advisory; never repair findings or merge. A standalone Ready draft
PR needs attention: offer ci (run CI and mark ready through the existing CI command)
and finish (leave draft as it stands). Resolve exactly the PR the scope report
reviewed into pr:{repo:{host,path},number}; never discover a different ambient PR.
A working diff with no PR offers no ci. Not-ready review offers retry and finish,
not code repair. A merged or closed PR is terminal; verify it before completing.

CI result: `$INPUTS.ci`. CI target check: `$INPUTS.ci_target`.
Green CI completes the explicitly selected handoff. A refused target, head movement,
conflict, red or gated CI asks again, naming the evidence. CI retries offer ci,
not retry (which reviews again). Preserve the reviewed target from previous.pr when
answering a CI stop; never substitute a newly discovered PR. Do not claim the review
became not-ready because CI is red; the CI report and attention explain the stop.
Only retry, ci and finish are implemented.
