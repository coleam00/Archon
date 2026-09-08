# Discoveries

Revalidate findings, search related work, and prepare proposals. Use
`discovery_artifact` with an explicit discoveries JSON file produced by review or
implementation. This path works on existing Archon and needs no new engine API.
Optional `run_id` lookup requires a CLI exposing `artifacts_dir`; it is not a
factory dependency. Prefer an explicit artifact when using the base engine.

`publication=preview` is read-only (default). `publication=approve` uses a native
approval node. `publication=auto` explicitly authorizes this run's publication,
subject to project guidance. The publication command uses gh directly, repeats
deduplication immediately before writing, and reads the result back. No forge
plugin, publication database, or separate publication workflow is required.

The return remains the proposal counts for existing consumers. Publication URLs
and partial failures are recorded by the publish node and discovery-publication.md.
The proposal document itself is evidence, never an authorization receipt.

The existing evidence checks and classification fixtures cover proposal creation.
The new publication command and approval path have not been executed in this
cleanup pass. No fresh runtime or end-to-end validation is claimed.
