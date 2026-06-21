# Review Resolution Report

Report Format Version: 1

## Run Context

- Run ID: 01KVNXFB1JK4ZRG1M1HV3E1VE8
- Repository identifier or path: /Users/dale/Desktop/workspace/OceanLabs/workflow-engine/Archon
- Branch: 001-manual-node-retry-decisions
- Base commit: 669a000ff8b1c95ad049531d19bf249f3281bc0a
- Current/final head commit: cc07e0c69cbaeee0b18476fb2e1baeec0a95b011
- Review step status: completed
- Report lifecycle state: in_progress
- First generated timestamp: 2026-06-21T20:34:12Z
- Last refreshed timestamp: 2026-06-21T20:53:38Z
- Finalized timestamp: not finalized
- Repo report path: /Users/dale/.archon/workspaces/coleam00/archon/worktrees/archon/thread-2481a3ef/no-mistakes/001-manual-node-retry-decisions/review-resolution.md

## Counts

- Resolved: 0
- Accepted Without Fix: 2
- Informational / No Action Required: 0
- Still Open: 5
- Total Entries: 7

## Resolved Issues

No issues in this category.

## Accepted Without Fix

### resume-hydration-ignores-retry-epoch

- Finding ID: resume-hydration-ignores-retry-epoch
- Severity: error
- File and line: packages/core/src/workflows/store-adapter.ts:74
- Action: auto-fix
- Source: agent
- Review round ID: 2
- Description: Resume hydration still uses the legacy \`getCompletedDagNodeOutputs\`, so a normal resume after a manual retry can ignore \`node_retry_requested\` invalidations and hydrate stale epoch-0 outputs. If retry epoch 1 fails before the retried node completes, \`/workflow resume\` can skip that failed invalidated node using its old completion output; wire this store method to the epoch-aware hydration helper.
- Context: unavailable in historical data
- Suggested/proposed fix: unavailable in historical data
- Risk level: unavailable in historical data
- Risk rationale: unavailable in historical data
- User instructions: not recorded
- Outcome: Accepted Without Fix
- Outcome evidence and provenance: Persisted Review terminal decision accepted the finding without a fix.
- Selection source: not recorded
- Decision action: approve
- Decision actor/source: user
- Decision timestamp: 2026-06-21T20:53:38Z
- Decision round ID: 01KVNZBPKXHZ3NJGX0EAVC0VXR
- Decision reason: approved without fix
- Fix round ID: not recorded
- Applied Solution Source: not applicable
- Applied solution or attempted solution: not recorded
- Rationale: not recorded
- Changed files: not recorded
- Fix commit SHA: not recorded
- No-commit reason: not recorded
- Verification text: accepted without fix by user
- Follow-up round ID: not recorded
- Scope-equivalence note: not recorded
- Verifier source: review terminal decision
- Evidence reference: persisted review resolution decision 01KVNZBPKXHZ3NJGX0EAVC0VXR
- Evidence quality: structured

### upstream-pre-node-checkpoint-fallback

- Finding ID: upstream-pre-node-checkpoint-fallback
- Severity: warning
- File and line: packages/core/src/db/workflow-checkpoints.ts:113
- Action: ask-user
- Source: agent
- Review round ID: 2
- Description: \`findLatestCheckpointForRetry\` falls back to an upstream dependency checkpoint, but DAG checkpoints are written before a node starts. Retrying from an upstream checkpoint while preserving that upstream node&\#39;s output can leave the checkout missing the upstream node&\#39;s file changes while the executor skips it; confirm this fallback is intended, or treat missing target checkpoints as no usable checkpoint unless post-node checkpoints exist.
- Context: unavailable in historical data
- Suggested/proposed fix: unavailable in historical data
- Risk level: unavailable in historical data
- Risk rationale: unavailable in historical data
- User instructions: not recorded
- Outcome: Accepted Without Fix
- Outcome evidence and provenance: Persisted Review terminal decision accepted the finding without a fix.
- Selection source: not recorded
- Decision action: approve
- Decision actor/source: user
- Decision timestamp: 2026-06-21T20:53:38Z
- Decision round ID: 01KVNZBPKXHZ3NJGX0EAVC0VXR
- Decision reason: approved without fix
- Fix round ID: not recorded
- Applied Solution Source: not applicable
- Applied solution or attempted solution: not recorded
- Rationale: not recorded
- Changed files: not recorded
- Fix commit SHA: not recorded
- No-commit reason: not recorded
- Verification text: accepted without fix by user
- Follow-up round ID: not recorded
- Scope-equivalence note: not recorded
- Verifier source: review terminal decision
- Evidence reference: persisted review resolution decision 01KVNZBPKXHZ3NJGX0EAVC0VXR
- Evidence quality: structured

## Informational / No Action Required

No issues in this category.

## Still Open Issues

### checkpoint-commit-message-contract

- Finding ID: checkpoint-commit-message-contract
- Severity: warning
- File and line: packages/git/src/retry-refs.ts:106
- Action: ask-user
- Source: agent
- Review round ID: 1
- Description: Checkpoint commit messages do not match the required audit format and omit workflowName/run/epoch/node fields in the specified layout. Align the helper signatures/messages with the retry spec, or explicitly update the contract if this shorter local history format is intentional.
- Context: unavailable in historical data
- Suggested/proposed fix: unavailable in historical data
- Risk level: unavailable in historical data
- Risk rationale: unavailable in historical data
- User instructions: not recorded
- Outcome: Still Open
- Outcome evidence and provenance: No persisted acceptance or comparable resolved evidence was recorded.
- Selection source: user
- Decision action: fix
- Decision actor/source: user
- Decision timestamp: 2026-06-21T20:34:13Z
- Decision round ID: 01KVNY84AHKQYHT8SQ86XY46JT
- Decision reason: selected for fix
- Fix round ID: 2
- Applied Solution Source: fix agent structured output
- Applied solution or attempted solution: Updated checkpoint ref creation to accept workflowName, build the exact multi-line audit commit message, normalize control characters in audit fields, and updated checkpoint call sites/tests.
- Rationale: Keeping the format in the git helper centralizes the contract at the commit creation boundary and ensures every checkpoint writer uses the required recoverable audit format.
- Changed files: packages/git/src/git.test.ts, packages/git/src/index.ts, packages/git/src/retry-refs.ts, packages/workflows/src/dag-executor.ts
- Fix commit SHA: cc07e0c69cbaeee0b18476fb2e1baeec0a95b011
- No-commit reason: not recorded
- Verification text: verification inconclusive
- Follow-up round ID: not recorded
- Scope-equivalence note: no comparable parsed follow-up evidence
- Verifier source: report classifier
- Evidence reference: persisted review resolution decision 01KVNY84AHKQYHT8SQ86XY46JT
- Evidence quality: structured

### loop-iteration-state-dropped

- Finding ID: loop-iteration-state-dropped
- Severity: warning
- File and line: packages/web/src/components/workflows/WorkflowExecution.tsx:217
- Action: auto-fix
- Source: agent
- Review round ID: 1
- Description: Using server nodeStates bypasses the existing event-based loop iteration enrichment, so completed or reloaded loop nodes lose currentIteration/maxIterations/iterations in the DAG sidebar and graph. Preserve the loop-iteration fold when nodeStates is present, or include equivalent iteration fields in the server projection.
- Context: unavailable in historical data
- Suggested/proposed fix: unavailable in historical data
- Risk level: unavailable in historical data
- Risk rationale: unavailable in historical data
- User instructions: not recorded
- Outcome: Still Open
- Outcome evidence and provenance: No persisted acceptance or comparable resolved evidence was recorded.
- Selection source: user
- Decision action: fix
- Decision actor/source: user
- Decision timestamp: 2026-06-21T20:34:13Z
- Decision round ID: 01KVNY84AHKQYHT8SQ86XY46JT
- Decision reason: selected for fix
- Fix round ID: 2
- Applied Solution Source: fix agent structured output
- Applied solution or attempted solution: Factored DAG node projection so loop iteration enrichment is applied whether nodes come from server nodeStates or from raw event folding, with regression coverage for server-projected nodeStates.
- Rationale: The dropped state was caused by bypassing the existing loop fold when nodeStates existed; applying the fold after either projection fixes reload/completed views without changing the API contract.
- Changed files: packages/web/src/components/workflows/WorkflowExecution.test.tsx, packages/web/src/components/workflows/WorkflowExecution.tsx
- Fix commit SHA: cc07e0c69cbaeee0b18476fb2e1baeec0a95b011
- No-commit reason: not recorded
- Verification text: verification inconclusive
- Follow-up round ID: not recorded
- Scope-equivalence note: no comparable parsed follow-up evidence
- Verifier source: report classifier
- Evidence reference: persisted review resolution decision 01KVNY84AHKQYHT8SQ86XY46JT
- Evidence quality: structured

### missing-head-reset-fallback

- Finding ID: missing-head-reset-fallback
- Severity: error
- File and line: packages/core/src/operations/workflow-retry.ts:211
- Action: auto-fix
- Source: agent
- Review round ID: 1
- Description: For mutating workflows with no target/upstream checkpoint, this path records reset_skipped and dispatches without creating a safety ref or resetting to HEAD. That leaves failed-attempt tracked changes in place for older/no-checkpoint runs; the no-checkpoint fallback should still create the safety ref and reset tracked files to current HEAD, reserving reset_skipped for mutates_checkout:false.
- Context: unavailable in historical data
- Suggested/proposed fix: unavailable in historical data
- Risk level: unavailable in historical data
- Risk rationale: unavailable in historical data
- User instructions: not recorded
- Outcome: Still Open
- Outcome evidence and provenance: No persisted acceptance or comparable resolved evidence was recorded.
- Selection source: user
- Decision action: fix
- Decision actor/source: user
- Decision timestamp: 2026-06-21T20:34:13Z
- Decision round ID: 01KVNY84AHKQYHT8SQ86XY46JT
- Decision reason: selected for fix
- Fix round ID: 2
- Applied Solution Source: fix agent structured output
- Applied solution or attempted solution: Changed mutating no-checkpoint retries to resolve the pre-safety HEAD, create the retry safety ref, reset tracked files back to that resolved HEAD, and emit node\\\_retry\\\_reset with reset\\\_skipped false.
- Rationale: This preserves failed-attempt tracked work in the safety ref while still discarding uncommitted tracked changes from the working tree, reserving reset\\\_skipped for true no-reset workflows.
- Changed files: packages/core/src/operations/workflow-retry.test.ts, packages/core/src/operations/workflow-retry.ts
- Fix commit SHA: cc07e0c69cbaeee0b18476fb2e1baeec0a95b011
- No-commit reason: not recorded
- Verification text: verification inconclusive
- Follow-up round ID: not recorded
- Scope-equivalence note: no comparable parsed follow-up evidence
- Verifier source: report classifier
- Evidence reference: persisted review resolution decision 01KVNY84AHKQYHT8SQ86XY46JT
- Evidence quality: structured

### retry-before-path-lock

- Finding ID: retry-before-path-lock
- Severity: error
- File and line: packages/core/src/operations/workflow-retry.ts:238
- Action: auto-fix
- Source: agent
- Review round ID: 1
- Description: Retry setup creates the safety ref and performs the checkout reset before the normal executor path-lock guard runs. If another workflow is active on the same working_path, this can rewrite tracked files underneath that active run; check for an active run on the path immediately after the retry CAS and before any git mutation, then restore the retried run to failed if blocked.
- Context: unavailable in historical data
- Suggested/proposed fix: unavailable in historical data
- Risk level: unavailable in historical data
- Risk rationale: unavailable in historical data
- User instructions: not recorded
- Outcome: Still Open
- Outcome evidence and provenance: No persisted acceptance or comparable resolved evidence was recorded.
- Selection source: user
- Decision action: fix
- Decision actor/source: user
- Decision timestamp: 2026-06-21T20:34:13Z
- Decision round ID: 01KVNY84AHKQYHT8SQ86XY46JT
- Decision reason: selected for fix
- Fix round ID: 2
- Applied Solution Source: fix agent structured output
- Applied solution or attempted solution: Added a retry-side active working\\\_path guard immediately after the retry CAS and before checkpoint lookup, safety ref creation, or reset; blocked retries restore the run to failed and surface a 409 from the API.
- Rationale: This reuses the same ownership rule as normal workflow dispatch at the earliest point retry setup has a claimed run identity, preventing checkout mutation under another active run.
- Changed files: packages/core/src/operations/workflow-retry.test.ts, packages/core/src/operations/workflow-retry.ts, packages/server/src/routes/api.ts
- Fix commit SHA: cc07e0c69cbaeee0b18476fb2e1baeec0a95b011
- No-commit reason: not recorded
- Verification text: verification inconclusive
- Follow-up round ID: not recorded
- Scope-equivalence note: no comparable parsed follow-up evidence
- Verifier source: report classifier
- Evidence reference: persisted review resolution decision 01KVNY84AHKQYHT8SQ86XY46JT
- Evidence quality: structured

### safety-commit-message-contract

- Finding ID: safety-commit-message-contract
- Severity: warning
- File and line: packages/git/src/retry-refs.ts:120
- Action: ask-user
- Source: agent
- Review round ID: 1
- Description: Safety commit messages have the same contract drift: they omit workflowName and retry node, and use a different one-line format than the specified multi-line audit message. This reduces recoverability/audit clarity for failed-attempt commits.
- Context: unavailable in historical data
- Suggested/proposed fix: unavailable in historical data
- Risk level: unavailable in historical data
- Risk rationale: unavailable in historical data
- User instructions: not recorded
- Outcome: Still Open
- Outcome evidence and provenance: No persisted acceptance or comparable resolved evidence was recorded.
- Selection source: user
- Decision action: fix
- Decision actor/source: user
- Decision timestamp: 2026-06-21T20:34:13Z
- Decision round ID: 01KVNY84AHKQYHT8SQ86XY46JT
- Decision reason: selected for fix
- Fix round ID: 2
- Applied Solution Source: fix agent structured output
- Applied solution or attempted solution: Updated retry safety ref creation to accept workflowName and retry node id, build the exact multi-line safety audit commit message, and updated retry setup/tests.
- Rationale: The safety commit needs the workflow/run/epoch/retry-node context for recovery; placing it in the shared helper prevents shorter local-history messages from recurring.
- Changed files: packages/core/src/operations/workflow-retry.test.ts, packages/core/src/operations/workflow-retry.ts, packages/git/src/git.test.ts, packages/git/src/index.ts, packages/git/src/retry-refs.ts
- Fix commit SHA: cc07e0c69cbaeee0b18476fb2e1baeec0a95b011
- No-commit reason: not recorded
- Verification text: verification inconclusive
- Follow-up round ID: not recorded
- Scope-equivalence note: no comparable parsed follow-up evidence
- Verifier source: report classifier
- Evidence reference: persisted review resolution decision 01KVNY84AHKQYHT8SQ86XY46JT
- Evidence quality: structured
