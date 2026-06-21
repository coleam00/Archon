# Manual Failed-Node Retry Decisions

Created: 2026-06-21T12:39:00+07:00
Mode: grill-me normal
Source: User interview about adding a Retry button on failed workflow DAG nodes.

## Scope

1. Manual retry targets a failed DAG node and reruns that node plus its downstream descendants.
2. Upstream completed nodes keep their prior outputs and are not rerun.
3. Independent sibling nodes in the same parallel layer are not invalidated unless they depend on the retry target.
4. Only nodes with status `failed` show a retry action. Downstream `skipped` nodes do not get their own retry action.
5. Retry is allowed only when the workflow run status is `failed`, not while it is `running`, `pending`, `paused`, `completed`, or `cancelled`.
6. Retry reuses the same `workflow_runs` row rather than creating a linked run.
7. If retry eventually succeeds, the run row status becomes `completed`; final run status wins over older failed events.

## Git Checkpoint Semantics

8. The feature supports both managed worktrees and `--no-worktree` live checkouts.
9. Archon may create real local checkpoint commits/refs in the repo, including for `--no-worktree`.
10. Checkpoint commits are allowed to live on the current branch for v1, even if they may later appear in PR/history. Keep implementation simple.
11. Checkpoint commits are local-only; Archon does not push checkpoint refs.
12. Checkpoint commits are not emitted as workflow artifacts.
13. Checkpoint commits are not rewritten, squashed, or dropped automatically after workflow success.
14. Cleanup deletes checkpoint refs by run prefix when deleting or cleaning old workflow runs. Cleanup failure logs a warning and should not break DB cleanup.
15. Checkpoint commit messages must not include the user prompt.
16. Checkpoint message format:

```text
archon checkpoint: <workflowName>/<nodeId>

Run: <runId>
Epoch: <retryEpoch>
Node: <nodeId>
```

17. Manual retry safety commit message format:

```text
archon retry safety: <workflowName>

Run: <runId>
Epoch: <nextRetryEpoch>
Retry node: <nodeId>
```

18. Before an executable node starts, Archon creates a checkpoint for the node about to run. The checkpoint represents "state immediately before this node".
19. If the checkout is dirty before node start, Archon commits all dirty changes and stores that commit as the node checkpoint.
20. If the checkout is clean before node start, Archon stores the current `HEAD` as the node checkpoint with `created_commit: false`.
21. If a target node has no checkpoint row, fallback to the checkpoint of its upstream node. If there are multiple upstream nodes, use `depends_on[0]`.
22. If no target or upstream checkpoint exists, fallback is `git reset --hard`, meaning reset tracked files to current `HEAD`.
23. If the target is the first node and it has a checkpoint row pointing to `HEAD`, use that row instead of empty fallback.
24. Validate checkpoint refs/SHAs with `git rev-parse --verify <ref/sha>^{commit}` before reset. If validation fails, retry setup fails and run stays `failed`.
25. Reset failures fail fast. Do not dispatch/resume executor if checkout reset did not succeed.
26. If git identity is missing and checkpoint commit fails, fail fast with clear git config guidance. Do not fallback to stash.
27. If repo is not a git repo, error immediately.
28. Retry v1 only resets tracked files. It does not run `git clean` and does not delete untracked or ignored files.
29. Before manual retry reset, always create/update a safety ref for current `HEAD`.
30. If checkout is dirty before manual retry reset, commit dirty changes first, then point the safety ref at that safety commit.
31. Retry rewrites the local branch tip back to the checkpoint and continues from there. Failed-attempt commits remain recoverable through safety refs.
32. Creating checkpoint commits makes the tree clean between nodes. This is acceptable; workflows should not rely on inter-node changes being uncommitted.

## Retry Epoch And Invalidation

33. Use retry epochs to distinguish old attempts from retried attempts.
34. Default epoch is `0`; events without `retry_epoch` are treated as epoch `0`.
35. Each manual retry increments `workflow_runs.metadata.retry_epoch`.
36. Write `node_retry_requested`, `node_retry_reset`, and `node_retry_failed` events.
37. `node_retry_requested` records target node, retry epoch, and invalidated nodes.
38. `node_retry_reset` records checkpoint/ref used and safety ref/commit.
39. `node_retry_failed` records setup/reset failure before dispatch.
40. Invalidated nodes are the target node plus descendants according to the current workflow DAG.
41. Completed outputs from invalidated nodes in prior epochs must not hydrate or substitute into retried nodes.
42. Upstream non-invalidated outputs may still hydrate and substitute.
43. Artifacts and logs from old attempts are not deleted. Epoch separates attempt history.
44. Workflow definition used for descendant calculation is the current workflow definition in v1.
45. If the current workflow definition no longer contains the target node or creates incompatible retry state, return a clear error.
46. If workflow file changed such that old downstream nodes are no longer in the current DAG, accept current-DAG invalidation and optionally warn.
47. `always_run` has no special manual retry behavior. Retry invalidation decides rerun scope.

## Checkpoint Storage

48. Add a dedicated DB table for node checkpoints, not just workflow events or run metadata.
49. Checkpoint write failure is fatal for the node/workflow. Do not continue execution without a checkpoint when checkpointing is required.
50. Checkpoint table unique key is `(workflow_run_id, node_id, retry_epoch)`.
51. Store at least: `workflow_run_id`, `node_id`, `retry_epoch`, `checkpoint_ref`, `commit_sha`, `created_commit`, `fallback_from_node_id`, and `created_at`.
52. During retry epoch `N + 1`, reset uses the latest prior checkpoint for the target if present.
53. When the retried node starts in epoch `N + 1`, it writes a new checkpoint row under epoch `N + 1`.
54. A later retry uses the latest checkpoint for the target, e.g. epoch `1` after epoch `1` failed.
55. No checkpoint info panel is needed in the UI for v1.

## Workflow Execution Behavior

56. Manual retry is separate from existing YAML auto retry.
57. Do not change existing auto retry behavior.
58. Manual retry still honors existing YAML `retry` config when the node executes.
59. Checkpoint/reset applies only to manual retry and the pre-node checkpoint system, not to auto retry attempts.
60. For `mutates_checkout !== false`, checkpointing is enabled by default.
61. Do not add a new config flag in v1.
62. For `mutates_checkout: false`, do not create checkpoints by default.
63. For `mutates_checkout: false`, manual retry is still allowed; if no checkpoint row exists, retry invalidates/reruns without resetting checkout.
64. Create checkpoints only for nodes that will actually execute, after trigger/when checks pass.
65. Do not checkpoint skipped nodes.
66. Checkpoint prompt, command, bash, script, and loop nodes.
67. Do not checkpoint approval or cancel nodes.
68. If checkpoint creation fails before a downstream node, fail that node/workflow clearly and do not run it.
69. Keep current parallel DAG execution behavior.
70. Add a warning if a layer has multiple executable mutating-capable nodes.

## AI Session State

71. Manual retry resets persisted AI sessions for the target node and downstream descendants.
72. Delete persisted session rows for all providers for invalidated nodes in the run's scope.
73. This makes retried AI nodes run fresh instead of carrying failed-attempt memory.

## API, CLI, And UI

74. Add a node-level retry API, conceptually `POST /api/workflows/runs/:runId/nodes/:nodeId/retry`.
75. Web API retry dispatches async, similar to the existing run resume endpoint.
76. API prepares retry state, safety ref/commit, reset, invalidation, then dispatches `/workflow run <name> <user_message>` into the parent web conversation.
77. Retry transition uses compare-and-swap from `failed` to `running`; if status changed, return an error.
78. API response shape includes `success`, `message`, `runId`, `nodeId`, `retryEpoch`, `invalidatedNodes`, and optional `safetyCommitSha`.
79. Web retry supports web-created runs with a parent web conversation.
80. CLI-created runs are retried via CLI, not via the Web UI in v1.
81. Add CLI command `workflow retry-node <run-id> <node-id>`.
82. CLI `retry-node` streams output to the terminal like `workflow resume`.
83. Do not support `--json` for `workflow retry-node` in v1.
84. Do not add retry-node to the native `manage_run` AI tool in v1.
85. UI shows retry button only on failed nodes.
86. UI retry requires a confirmation dialog.
87. Confirmation copy should mention: tracked files reset to checkpoint, dirty changes are auto-committed to safety ref first, untracked/ignored files are not deleted, and target/downstream nodes rerun.
88. UI button shows loading/disabled state after click.
89. After successful API response, UI invalidates/refetches the workflow run query.
90. If API returns an error, UI shows the error and leaves run status failed.

## Accepted Tradeoffs

91. Checkpoint commits may pollute local branch history and PRs in v1.
92. Retry only resets tracked files; untracked/ignored leftovers may remain.
93. Retry can rewrite the local branch tip back to the selected checkpoint.
94. Safety refs preserve recoverability for current `HEAD` and dirty state before reset.
95. Current workflow definition is source of truth for retry DAG calculation in v1.
