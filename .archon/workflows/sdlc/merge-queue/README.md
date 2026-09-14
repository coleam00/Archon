# Merge queue

`archon-merge-queue` accepts `prs` (1-5 explicit PR URLs), optional `evidence`,
`merge_method` (`merge|squash|rebase`), and `mode=preview|approve|auto`. Evidence
may be an empty array when validation and review are GitHub-only; file-backed
entries bind an exact path and SHA-256 and are rechecked before any write. It uses two medium command agents with a native
approval node between them. GitHub operations and CI inspection use gh inside
those nodes, with explicit repository and expected head identity.

Approval covers the recorded batch. Auto explicitly authorizes that batch without
a human pause, subject to repository guidance. Processing is sequential. Changed
heads, unrelated base movement, stale validation after an earlier merge, unresolved
findings, conflicts and pending checks hold the remaining work. GitHub-native
queues remain held when queue membership or merge state is unconfirmed; they are
not reported as queued without structured read-back. No admin bypass is used.

After a confirmed merge, the result records `prior_base_sha` so the next iteration
can detect movement of the live base branch.

A hold a PR's own next commit can fix is published on that PR as one comment
beginning `<!-- archon-merge-hold -->` (edited in place, cleared when the PR
becomes eligible); the shared review reads it as a claim to settle when a delivery
is re-driven on the branch. Transient holds (pending checks, base movement) stay in
the run's merge-plan.md.

This replaces the custom forge-backed candidate composer and automatic-policy
follow-up. It does not locally synthesize multi-PR commits, alter worktree ownership,
or add an engine API. GitHub branch protection owns atomic server-side merge checks.
The returned `merged` value is a business result, not an inferred engine status.

Focused boundary tests cover GitHub-only empty evidence, file binding failures,
method and approval guards, and the fake-`gh` write boundary. Live merge behavior
and prompt compliance remain unverified.
