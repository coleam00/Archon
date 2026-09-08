# Cold PR repair

Invoke `archon-revise-pr` with `target_pr` (a positive number in origin),
`work_order` (the original accepted brief), `findings` (the public repair
findings), and optionally `publication_policy` (the PR package's external JSON
policy). Work order and findings may contain readable paths or inline text.
They are handed to the existing implementation workflow without a second repair
planner or reasoning prompt.

The workflow explicitly requires an isolated worktree. It resolves the open
same-repository PR, fetches its head, refuses stale identity, and creates a fresh
local branch at that exact head. The PR's own branch is usually still checked out
in the worktree of the run that opened it, so repair never takes it over: no
existing checkout or branch is reset, cleaned, moved or deleted. It refuses dirty
files, a primary checkout, fork PRs, and protected head names. A fresh clone plus
an engine-created worktree supports a cold invocation without artifacts from the
original run.

Implementation must finish green. Publication pins the original PR identity,
runs the optional fixed policy, and pushes the committed SHA to the same head
without force. It preserves the PR's base and draft state and never creates a
replacement. A changed remote head or base refuses publication for operator
reconciliation. The caller decides whether and when another attempt is useful.

The result uses the delivery object contract, persisted in `revise-result.json`.
Here `delivered` means the repaired head was published to the same PR, not that
acceptance passed. The caller owns independent acceptance, attempt counts,
labels and merging. No automatic acceptance or merge is performed.

Fixed publication gates are mandatory when configured; a model's summary cannot
waive them. Worktrees and tool restrictions do not provide an execution sandbox.
