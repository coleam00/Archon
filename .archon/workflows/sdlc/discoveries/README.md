# Discovery proposals

Run archon-discoveries with discovery_artifact set to a readable JSON file.
It accepts the consolidated discoveries.json produced by review-synthesize
or one raw review/implementation sidecar. Both are arrays of title, claim,
evidence strings and relation; raw records use source_node, consolidated
records use source_nodes. Source attribution stays in the local normalized
artifact. Malformed records fail clearly. Missing evidence remains unverified.

The graph is resolve-input, revalidate, check-evidence, search-existing,
classify, render. Agents are medium command nodes using native project
guidance. Scripts pin this checkout's HEAD, validate source bounds and
identities, and render proposals. They do not fetch or switch to the default
branch. A changed HEAD requires a fresh proposal run.

The action set is discovery-proposals.json with revision, forge status,
publication_authorized: false, and proposals. Each proposal records its
classification, model_verdict, evidence_status, source citations, optional
target and marker, public title/summary/rationale, and actionable flag.
The same content is rendered in discovery-proposals.md. The workflow return
contains total and per-classification counts.

The four classifications are stale, duplicate, update-existing, and new.
Stale means the model disproved the claim. Supported, disproved, and
inconclusive model verdicts remain separate from source-bound/unverified
citation status. Source-bound means every cited regular file and line exists
at the pinned revision; it does not prove the claim. A new or update-existing
proposal is actionable only with a supported model verdict, source-bound
citations, and completed forge reads. It still has no publication authorization.

GitHub.com origins can use gh repository reads. No origin, other forge hosts,
a missing CLI, or failed access produce local proposals with an observable
unavailable reason. An unknown identity never receives a guessed marker.
Enterprise GitHub and other forge adapters are not implemented in this slice.
Search agents are instructed to read paginated exact markers and semantic
matches. Marker stability uses SHA-256 of the normalized repository identity
and normalized original title. A changed title changes the marker; semantic
deduplication is still needed. Repeated title keys in one input are rejected.

Any nonempty run_id fails explicitly, including when an artifact is supplied.
archon workflow get <id> --json already exposes output_root and
leave_behind.artifactFiles. The missing owning field is a canonical absolute
artifacts_dir. The pack does not reconstruct engine storage paths or read
its database.

Public text is drafted separately from private raw evidence. The renderer
requires the model's disclosure judgment and rejects obvious absolute paths;
it cannot identify arbitrary confidential prose. Review the text and citations
before sharing. Normalized input, model notes and intermediate artifacts
remain local evidence, not public proposal content.

All nodes declare mutates_checkout: false. Revalidation and search restrict
built-in tools to Read/Grep/Glob/Bash; classification needs only Read.
Supported providers enforce those tool lists. Codex does not support per-call
tool restrictions and warns. Bash can still perform external writes, and
checkout declarations do not constrain tracker APIs. These declarations and
read-only instructions are not an external-write sandbox.

## Verification

The package test discovery-proposals.test.ts executes the real Python script
entry points and real git operations against a plain scratch repository.
Agent outputs and the gh repository-read transport are simulated. It checks
the four classes, actual HEAD movement, citation bounds, duplicate indices and
input keys, missing/malformed artifacts, no-forge output, target identity,
disclosure refusal, and stable markers. All scripted subprocess operations are
recorded; the transport refuses unexpected forge operations. No tracker API is
called. The tests also compare Python vocabularies with the YAML contracts.

The two .scenario.yaml files require that harness's synthetic example/repo
identity. The .stubs.yaml files are portable workflow CLI fixtures; they run
scripts for real but simulate agents. The no-forge fixture simulates an
incomplete search; the package test is what proves a genuinely absent origin.
stale-revision-moved simulates a model's staleness judgment; actual revision
movement is tested separately by committing changed source in the scratch repo.

Run the focused package test from packages/workflows, and run
bun run cli workflow test archon-discoveries --json from the repository root.
Fixtures cannot prove live model revalidation, semantic deduplication,
disclosure judgment, or provider enforcement. Those require live verification.

## Governed publication follow-up

Extend this workflow responsibility in a separate focused slice. Bind an
explicit human batch decision to the exact reviewed actions, recheck source
and deduplication after approval delays, use the owning forge create/upsert
contract, paginate marker checks immediately before writing, read writes back,
and handle uncertain responses idempotently. Settle stable finding keys before
claiming title-independent deduplication. Neither actionable nor publish=true
can supply approval. No global discovery database or receipt protocol is added.
