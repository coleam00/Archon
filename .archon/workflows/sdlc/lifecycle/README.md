# Issue-to-merge lifecycle

`archon-lifecycle` composes the existing shared ship (including independent review,
validation and delivery correction loops), runtime verification, a fresh holdout,
discoveries, merge queue and, optionally, deployment. Inputs are `target`, absolute
`scenario` and `holdout` paths, `merge_mode`, `merge_method`, `discovery_publication`, `publish`,
and the optional `deploy`/`health`/`identity` commands forwarded to `archon-deploy`
after a confirmed merge. Modes default to approval and preview; select auto
explicitly for unattended publication/merge. Set `merge_method` to `merge`,
`squash`, or `rebase`; leaving it empty requires mandatory project guidance or
exactly one method enabled by the repository.

**Backlog intake.** An empty `target` makes the first node select the oldest open
issue in the origin repository that no earlier run has touched: no `archon-*`
state label and no open pull request naming it. That is deterministic `gh`
reading; whether the issue is worth building stays with triage. Set
`publish=true` so triage's state label marks the issue as touched, otherwise an
unattended schedule re-selects the same issue every tick. Nothing untouched
completes the run with nothing to do.

Project runtime environments are managed by the ordinary factory resource host.
The workflow requires evidence that the app being verified is the delivered
revision. An application failure at the unchanged PR head gets one shared archon-deliver
repair, with independent review, then fresh runtime and holdout verification.
Missing evidence, identity drift, infrastructure failure or a second failed
verification holds the handoff. The loop is bounded and visible in the graph.

No factory stage dispatcher, provider subprocess, forge extension or native
scheduler is required. Scheduling invokes this whole workflow externally.

Ordinary validation keeps its existing applicability receipt. Runtime and holdout
return their exact report, capture and evaluator references. `qualification-input`
checks these roles and snapshots source/review facts; a fresh `judge` compares the
actual cited observations once; `qualify` rechecks and seals that judgment. The
merge include receives only explicit sealed references. Changed source, scope,
context, scenarios, evaluator files, reports, captures or reviews invalidate them.

Runtime `candidate` identifies the probed instance and may be opaque; `checkout`
is Git HEAD. Qualification must inspect captured source-revision evidence linking
each instance to the delivered commit. It never substitutes Git HEAD for a live
target probe. Runtime and holdout must have distinct fresh producer nodes and
attempts and separate scenarios. External environment ownership and the agent's
semantic assessment remain required; hashes alone prove neither isolation nor
application correctness.

The lifecycle fixtures exercise composition and joins. Production receipt and
qualification tests cover tampering, distinct roles, opaque target identities,
standalone ordinary evidence and merge applicability. Native DAG tests cover
approval continuation without repeating validation or semantic qualification.
These tests use scratch data and fake provider/GitHub transports; they do not
replace a separately authorized live-provider acceptance run.
