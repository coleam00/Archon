---
title: Sample Artifacts
description: Secret-free sample run reports, approval reviews, workflow briefs, and PR readiness notes.
category: learning
audience: [user, operator]
status: current
sidebar:
  order: 16
---

Use these samples when learners need to see what "good enough evidence" looks
like. They are intentionally small and secret-free.

## Sample Run Report

```text
Workflow or command:
archon-assist

Repository:
~/archon-sandbox

Branch or worktree:
main, read-only run with --no-worktree

Request:
Explain this repository structure. Do not edit files.

Run status:
Completed

Files changed:
None. git status showed a clean working tree.

Artifacts inspected:
No implementation artifact expected for this read-only run.

Logs inspected:
Workflow log showed the request stayed read-only.

Validation command and result:
git status -> clean working tree

Human decision:
Accept the explanation as a learning result. No code action taken.

Follow-up:
Run the first modifying workflow on an isolated branch.
```

## Sample Workflow Design Brief

```text
Workflow name:
sandbox-add-subtract

Repeated task this solves:
Safely add a tiny function to the sandbox and validate it.

Inputs:
User request describing the function to add.

Nodes:
1. plan-change: write a plan artifact.
2. approve-plan: human approval gate.
3. implement-change: edit src/math.js and src/math.test.js.
4. validate-change: run npm test.
5. summarize-result: write a short result summary.

Artifact handoffs:
plan-change writes plan.md.
implement-change reads plan.md.
summarize-result reads validation output.

Deterministic validation:
npm test

Approval gates:
Before implementation.

Provider choice per node:
Use the baseline provider for all nodes until the workflow works.

Rollback path:
Discard the sandbox branch or worktree.

Known limits:
Only intended for the tiny JavaScript sandbox.
```

## Sample Model-Role Decision Note

```text
Project:
Add subtract(a, b) to the sandbox math module.

Planner:
codex, gpt-5.3-codex, medium reasoning.

Inner developer:
pi, openrouter/qwen/qwen3-coder.

Reviewer:
codex, fresh context from validation output and git diff.

Why this split:
Codex is already verified for repository planning and review. Qwen is being
tested only for the small implementation node after the single-provider
baseline worked.

Artifact handoff:
Plan node output is copied into the implementation prompt. Validation output is
copied into the review prompt.

Fallback:
If Pi auth or the Qwen model fails, stop the run or rerun implementation with
Codex. Do not skip validation.

Validation:
npm test
```

## Sample Team Runtime Boundary Note

```text
Runtime:
Local Docker rehearsal on a team laptop.

Database:
SQLite for rehearsal only. PostgreSQL required before shared server rollout.

Interface:
GitHub webhook simulation. No public webhook enabled yet.

Allowed users:
One reviewer and one learner during rehearsal.

Secrets:
Stored in Archon-owned env files. No tokens in shared notes.

Health checks:
/health and /health/db pass locally.

Logs:
Docker app logs and Archon workflow logs inspected.

Artifacts:
Workflow artifacts stored under the Archon workspace path.

Rollback:
Stop services, abandon run, discard sandbox branch or worktree.

Stop conditions:
Unexpected files changed, failed validation, missing webhook signature, or
secret exposure.
```

## Sample Approval Review

```text
Plan or output reviewed:
Plan artifact for adding subtract(a, b).

Decision:
revise

Reason:
The plan names src/math.js but does not name the test file or validation command.

Evidence used:
Plan artifact, current repository file list.

Risk accepted:
None yet. Implementation should not proceed.

Required revision:
Name src/math.test.js, state that npm test must pass, and include rollback by
discarding the branch.

Next validation:
Review revised plan before approving implementation.
```

## Sample Validation Note

```text
Validation command:
npm test

Result:
Passed

Output summary:
math tests passed

What this proves:
The current tiny math test passes.

What this does not prove:
It does not prove broad application correctness, performance, security, or PR
readiness.

Next action:
Inspect the diff and write a PR readiness note.
```

## Sample PR Readiness Note

```text
Issue or request:
Add subtract(a, b) to the sandbox math module.

Branch:
feature/subtract

PR link or PR-ready branch:
PR-ready branch only. No merge performed.

Summary of change:
Added subtract(a, b) to src/math.js and added a test for subtract(5, 2).

Validation evidence:
npm test passed.

Artifact evidence:
Plan artifact named files, validation command, risk, and rollback path.

Reviewer concerns:
Confirm function naming and whether more edge cases are needed.

Secrets checked:
No secrets in diff, artifacts, notes, or logs.

Residual risk:
Test coverage is intentionally tiny because this is a sandbox exercise.

Merge decision:
Stop for human review. Do not merge automatically.
```

## Sample Remediation Note

```text
Gap:
Learner approved a vague plan.

Session to repeat:
Approval gate drill.

Exercise:
Review the sample plan and reject it unless it names files, validation, risks,
and rollback.

Evidence required:
Written approval review with a concrete rejection reason and revision request.

Due date:
Before GitHub capstone.

Reviewer:
Facilitator or peer reviewer.
```

## What Makes These Samples Acceptable

They are:

- Specific enough for another person to understand the run.
- Clear about what evidence was inspected.
- Clear about what evidence does not prove.
- Explicit about human decisions.
- Free of secrets.
- Small enough to write during a workshop.
