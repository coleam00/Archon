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
Classic branch protection and applicable rulesets are combined. Their check-run,
commit-status, review and comment reads are paged; an API or permission failure
remains unknown.

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
`merge-hold.md` preserve the reasons for the caller.

This workflow does not synthesize multi-PR commits, alter worktree ownership, or
add an engine API. GitHub branch protection owns atomic server-side merge checks.
The returned `merged` value is confirmed by read-back and a queued request remains
`merged=false`.

The evidence qualification record is deliberately narrow in Stage A: semantic
state, fingerprint, and references. Later capture/handoff work can supply durable
provenance through those references without changing the merge plan contract.
