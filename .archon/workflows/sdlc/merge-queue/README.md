# Merge queue

`archon-merge-queue` accepts `prs` (1-5 explicit PR URLs), optional `evidence`,
and `mode=preview|approve|auto`. It uses two medium command agents with a native
approval node between them. GitHub operations and CI inspection use gh inside
those nodes, with explicit repository and expected head identity.

Approval covers the recorded batch. Auto explicitly authorizes that batch without
a human pause, subject to repository guidance. Processing is sequential. Changed
heads, unrelated base movement, stale validation after an earlier merge, unresolved
findings, conflicts and pending checks hold the remaining work. GitHub-native
queues remain queued until read-back confirms merging. No admin bypass is used.

This replaces the custom forge-backed candidate composer and automatic-policy
follow-up. It does not locally synthesize multi-PR commits, alter worktree ownership,
or add an engine API. GitHub branch protection owns atomic server-side merge checks.
The returned `merged` value is a business result, not an inferred engine status.

No tests or agent runs were performed for this simplification. In particular,
live merge behavior and prompt compliance remain unverified.
