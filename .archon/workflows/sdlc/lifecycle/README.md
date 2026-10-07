# Issue-to-merge lifecycle

`archon-lifecycle` composes the existing shared ship (including independent review,
validation and delivery correction loops), runtime verification, an optional fresh holdout,
discoveries, merge queue and, optionally, deployment. Inputs are `target`, an absolute
`scenario` path, an optional absolute `holdout` path (empty skips the holdout pass), `merge_mode`, `discovery_publication`, `publish`,
`state_labels`, `publish_holds`, `required_checks` (forwarded to the merge queue),
and the optional `deploy`/`health`/`identity` commands forwarded to `archon-deploy`
after a confirmed merge. Modes default to approval and preview; select auto
explicitly for unattended publication/merge.

**Backlog intake.** An empty `target` makes the first node select the oldest open
issue in the origin repository that has none of the labels named by the explicit
`state_labels` mapping, no open pull request claiming it, and no open dependency.
A pull request claims issue N only with a closing keyword or `Relates to #N`; a
bare `#N` mention does not. Dependencies are the backlog's `Depends on: #<n>`
lines, open while that number is an open issue or pull request. An issue whose
only state label is the mapped BLOCKED state, and which declares dependencies,
becomes a candidate again once they all close. When nothing is selectable,
`waiting_on` lists the open dependencies holding the backlog, so a stalled queue
is distinguishable from an empty one. Automatic intake stops
safely unless every state is mapped because it cannot reliably mark all touched work;
explicit targets still work with `{}`. Set `publish=true` to apply the mapped
triage state. The pack neither requires nor treats an `archon-*` prefix specially.

Runtime and holdout scenarios are caller-supplied project evidence; a project may
use its own runtime host or a source-provenance adapter. The workflow requires
evidence that the system being verified is the delivered revision. An application
failure at the unchanged PR head gets one shared archon-deliver
repair, with independent review, then fresh runtime and (when configured) holdout verification.
Missing evidence, identity drift, infrastructure failure or a second failed
verification holds the handoff. The loop is bounded and visible in the graph.

No stage dispatcher, provider subprocess, forge extension or native scheduler is
required. Scheduling invokes this optional opinionated composition externally.

The lifecycle is unattended-class, so a schedule or trigger can start it. Discoveries
and the merge queue run as child workflows: each keeps its own approval gate, so in
`approve` mode the child pauses and is approved by its own run id while the
lifecycle waits on it. With `merge_mode=auto` and `discovery_publication` set to
`preview` or `auto`, nothing pauses.
