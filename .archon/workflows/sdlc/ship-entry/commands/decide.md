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

The whole pipeline retries once on retry, preserving original inputs and the
answer. A blocked triage, unresolved planning question, capped delivery, human stop,
or unowned Ready PR needs attention. NO_ACTION, refuted cause, and verified merged
or closed PRs are terminal. Only retry and finish are implemented. Never merge.
