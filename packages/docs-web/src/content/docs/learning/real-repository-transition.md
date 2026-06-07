---
title: Real Repository Transition
description: How to move from Archon sandbox training into supervised real-repository work.
category: learning
audience: [user, operator]
status: current
sidebar:
  order: 29
---

Use this guide for the first real-repository run after curriculum graduation.
The first real run should be small, reversible, and reviewed.

## Entry Criteria

Do not start until the learner has:

- Completed a capstone.
- Passed or reviewed the graduation checklist.
- Chosen a low-risk repository.
- Named a reviewer.
- Defined validation.
- Defined rollback.

## Choose The First Repository

Good first repositories:

- Small internal tools.
- Documentation-heavy repositories.
- Repositories with fast tests.
- Repositories with easy rollback.
- Repositories where a reviewer is available.

Poor first repositories:

- Production-critical services.
- Repositories with unclear ownership.
- Repositories with slow or flaky validation.
- Repositories containing sensitive secrets.
- Repositories with no clear rollback path.

## Choose The First Task

Good first tasks:

- Documentation cleanup.
- Small test-backed bug fix.
- Narrow refactor with no behavior change.
- Adding a tiny helper with tests.
- Reviewing a PR without editing files.

Poor first tasks:

- Large rewrites.
- Authentication changes.
- Secret rotation.
- Production deployment.
- Multi-provider workflow experiments.
- Autonomous issue-to-merge loops.

## First Run Plan

```text
Repository:
Task:
Workflow:
Branch:
Reviewer:
Expected files:
Required artifact:
Required validation:
Rollback:
Stop conditions:
```

## During The Run

The learner should:

1. Confirm the repository and branch.
2. Run the workflow with isolation.
3. Inspect the plan artifact.
4. Get approval before implementation.
5. Inspect changed files.
6. Run deterministic validation.
7. Write a PR readiness note if creating a PR.
8. Stop for human review.

## After The Run

Record:

```text
What ran:
What changed:
What evidence was inspected:
What validation passed or failed:
What reviewer decided:
What rollback path remains:
What checklist item changed:
```

## Reviewer Checklist

```text
Repository was intended:
Branch/worktree was intended:
Files changed were expected:
Artifacts support the change:
Validation is appropriate:
Secrets are not exposed:
PR summary matches diff:
Residual risk is named:
Merge waits for review:
```

## Expand Carefully

After the first successful real run, expand one dimension at a time:

- Slightly larger task, or
- Another low-risk repository, or
- Another trained learner, or
- Another workflow.

Do not expand all dimensions at once.

## Transition Complete

The transition is complete when:

- The learner completes a real-repository run with supervision.
- The reviewer accepts the evidence trail.
- The team checklist is updated.
- The next allowed workflow is defined.
