# Issue-to-merge lifecycle

`archon-lifecycle` composes the existing shared ship (including independent review,
validation and delivery correction loops), runtime verification, a fresh holdout,
discoveries, merge queue and, optionally, deployment. Inputs are `target`, absolute
`scenario` and `holdout` paths, `merge_mode`, `discovery_publication`, `publish`,
and the optional `deploy`/`health`/`identity` commands forwarded to `archon-deploy`
after a confirmed merge. Modes default to approval and preview; select auto
explicitly for unattended publication/merge.

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
No tests or live runs were performed on this new composition.
