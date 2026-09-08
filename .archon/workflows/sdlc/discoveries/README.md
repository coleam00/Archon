# Discovery proposals

Run archon-discoveries with exactly one discovery_artifact or run_id.
An explicit artifact must be a readable JSON file.
It accepts the consolidated discoveries.json produced by review-synthesize
or one raw review/implementation sidecar. Both are arrays of title, claim,
evidence prose or an array of evidence strings, and relation; raw records use source_node, consolidated
records use source_nodes. Prose normalizes to one evidence entry without changing
its content or conferring verified status. Source attribution stays in the local normalized
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
and normalized original title, claim, and sorted distinct evidence strings.
Whitespace is normalized; title is case-folded, while claim and evidence retain
case. Producer names and input ordering do not change identity. Exact repeats
merge evidence and source attribution; conflicting relations fail as ambiguous.
Different claims or evidence remain separate even with the same generic title.
Changed wording or evidence changes the marker; semantic deduplication is still
needed. These are local proposal markers, not a shipped publication identity.

Run IDs use the public `archon workflow get <id> --json` contract from CLI
prerequisite commit 267aa206913353b1e14a2a2d086585f24f4f8cc4. The response must
identify the requested terminal run and return an absolute, readable
artifacts_dir and leave_behind.artifactFiles. The script never reads the engine
database or derives paths from output_root. CLI failure, unavailable storage,
unsafe names and symlink escapes fail clearly. Returned paths alone do not
establish that the listed artifacts exist: selected files must be read.

A listed root discoveries.json wins, including an empty array; malformed or
missing consolidation fails without falling back to raw data. Otherwise collect
listed direct discoveries/*.json arrays in filename order. Nested lookalikes
are not canonical inputs. No listed discovery yields an empty proposal set.
The CLI file walk can omit files at its cap or in an unreadable subtree. The
resolver checks the native discovery directory inventory under the returned
root and rejects incomplete listings or unreadable raw storage. It does not
silently supplement the CLI list with unlisted artifacts.
The local context records the source run and selected filenames, separately
from the checkout revision and destination forge identity used for proposals.
The source run may belong to another repository; every claim must still be
revalidated against the current checkout before it is actionable.

Standalone execution uses the normal archon executable on PATH and inherits
its installation environment. This branch and the CLI prerequisite do not
expose an engine CLI executable launch-context field. No source-file or install
path is guessed, and a failed CLI invocation does not switch installations.

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
Agent outputs and the archon/gh CLI transports are simulated. It checks
the four classes, actual HEAD movement, citation bounds, duplicate indices and
finding identities, run input precedence and path bounds, missing/malformed
artifacts, no-forge output, target identity,
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
