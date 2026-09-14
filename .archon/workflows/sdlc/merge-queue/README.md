# Merge queue

`archon-merge-queue` accepts `prs` (1-5 explicit PR URLs), optional `evidence`,
`merge_method=merge|squash|rebase`, and `mode=preview|approve|auto`. An empty
method is resolved only by mandatory project guidance or a repository with one
enabled method. A deterministic TypeScript collector reads GitHub policy and live
state, one agent judges review and supplied evidence, and a typed plan/executor
surround the native approval node.

Effective required-check policy, current check results, and applicable validation
evidence are independent facts. A repository with no required hosted CI may
proceed with qualified evidence. Unknown policy, missing or stale evidence, and
required checks that are pending, failing, missing, or unreadable hold the batch.
Classic branch protection and applicable rulesets are combined. Full protection
can explicitly require reviews without CI. The legacy contexts and richer app-bound
checks describe overlapping requirements; they do not imply separate channels.
When both a check run and commit status exist for a required name, both must pass.
App-bound requirements still need a run from that app.

If REST policy is unavailable, a complete GraphQL read of the exact branch ref
and inherited rulesets can resolve it. The ref must match the live base commit.
Nonempty GraphQL rulesets still require effective REST rules; an uninspected list,
partial response, pagination gap or unknown policy holds. Check-run, commit-status,
review and comment reads are paged.

Approval covers the recorded batch, evidence fingerprint, method, reviews, base,
and heads. Auto explicitly authorizes that batch without a human pause, subject to
repository guidance. Processing is sequential. The exact approved method becomes
the sole `gh` method flag and every request uses the approved head through
`--match-head-commit`. Changed heads, base or review material, disabled methods,
stale validation after an earlier merge, unresolved findings, conflicts and
pending checks hold the remaining work. GitHub-native queues remain queued until
read-back confirms merging. No admin bypass is used. Live-base reads detect
movement but are not an atomic base lock; GitHub protection remains authoritative.

Held and preview runs make no GitHub write. Their typed result and
`merge-hold.md` preserve classified reasons and assessed heads for the caller.
A new assessment replaces this local feedback, including clearing resolved holds.
Review and assessment still read historical `archon-merge-hold` PR comments and
check whether their reasons apply to the current head. Assessment no longer
publishes or edits those comments; the typed return and local report own current
feedback, so an old comment cannot perpetually block a resolved condition.

This workflow does not synthesize multi-PR commits, alter worktree ownership, or
add an engine API. GitHub branch protection owns atomic server-side merge checks.
The returned `merged` value is confirmed by read-back and a queued request remains
`merged=false`.

The evidence qualification record is deliberately narrow in Stage A: semantic
state, fingerprint, and references. Later capture/handoff work can supply durable
provenance through those references without changing the merge plan contract.
