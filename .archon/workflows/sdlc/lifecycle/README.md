# Issue-to-merge lifecycle

`archon-lifecycle` composes the existing shared ship (including independent review,
validation and delivery correction loops), runtime verification, a fresh holdout,
discoveries, merge queue and, optionally, deployment. Inputs are `target`, absolute
`scenario` and `holdout` paths, `merge_mode`, `discovery_publication`, `publish`,
`state_labels`, `publish_holds`,
and the optional `deploy`/`health`/`identity` commands forwarded to `archon-deploy`
after a confirmed merge. Modes default to approval and preview; select auto
explicitly for unattended publication/merge.

**Backlog intake.** An empty `target` makes the first node select the oldest open
issue in the origin repository that has none of the labels named by the explicit
`state_labels` mapping and no open pull request naming it. Automatic intake stops
safely unless every state is mapped because it cannot reliably mark all touched work;
explicit targets still work with `{}`. Set `publish=true` to apply the mapped
triage state. The pack neither requires nor treats an `archon-*` prefix specially.

Runtime and holdout scenarios are caller-supplied project evidence; a project may
use its own runtime host or a source-provenance adapter. The workflow requires
evidence that the system being verified is the delivered revision. An application
failure at the unchanged PR head gets one shared archon-deliver
repair, with independent review, then fresh runtime and holdout verification.
Missing evidence, identity drift, infrastructure failure or a second failed
verification holds the handoff. The loop is bounded and visible in the graph.

No stage dispatcher, provider subprocess, forge extension or native scheduler is
required. Scheduling invokes this optional opinionated composition externally.
