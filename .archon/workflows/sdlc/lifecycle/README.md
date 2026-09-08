# Issue-to-merge lifecycle

`archon-lifecycle` composes the existing shared ship (including independent review,
validation and delivery correction loops), runtime verification, a fresh holdout,
discoveries and merge queue. Inputs are `target`, absolute `scenario` and `holdout`
paths, `merge_mode` and `discovery_publication`. Modes default to approval and
preview; select auto explicitly for unattended publication/merge.

Project runtime environments are managed by the ordinary factory resource host.
The workflow requires evidence that the app being verified is the delivered
revision. An application failure at the unchanged PR head gets one shared archon-deliver
repair, with independent review, then fresh runtime and holdout verification.
Missing evidence, identity drift, infrastructure failure or a second failed
verification holds the handoff. The loop is bounded and visible in the graph.

No factory stage dispatcher, provider subprocess, forge extension or native
scheduler is required. Scheduling invokes this whole workflow externally.
No tests or live runs were performed on this new composition.
