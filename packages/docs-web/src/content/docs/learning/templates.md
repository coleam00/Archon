---
title: Curriculum Templates
description: Copy-ready learner, facilitator, run-report, workflow-brief, and PR-readiness templates.
category: learning
audience: [user, operator]
status: current
sidebar:
  order: 4
---

Use these templates in a private notebook or a safe shared training space. Do
not include secrets, token values, provider auth files, or full `.env` contents.

## Learner Daily Journal

```text
Date:
Tutorial part or session:
Workflow or command:
What I expected:
What actually happened:
Evidence I inspected:
Safety rule I practiced:
Question to revisit:
Checklist update:
```

## Run Report

```text
Workflow or command:
Repository:
Branch or worktree:
Request:
Run status:
Files changed:
Artifacts inspected:
Logs inspected:
Validation command and result:
Human decision:
Follow-up:
```

## Workflow Design Brief

```text
Workflow name:
Repeated task this solves:
Inputs:
Nodes:
Artifact handoffs:
Deterministic validation:
Approval gates:
Provider choice per node:
Rollback path:
Known limits:
```

## Approval Gate Review

```text
Plan or output reviewed:
Decision: approve / reject / revise / defer
Reason:
Evidence used:
Risk accepted:
Required revision:
Next validation:
```

## PR Readiness Note

```text
Issue or request:
Branch:
PR link or PR-ready branch:
Summary of change:
Validation evidence:
Artifact evidence:
Reviewer concerns:
Secrets checked:
Residual risk:
Merge decision:
```

## Personal Operating Checklist

```text
Before I run Archon:
- I am in the intended repository.
- The repository is disposable or low-risk enough for the task.
- Secrets are stored locally and not pasted into chat.
- The workflow has the right branch or worktree behavior.
- Custom commands and workflows are validated.

Before I approve implementation:
- I inspected the plan artifact.
- The plan names files, validation commands, risks, and rollback steps.
- The approval gate is explicit.

Before I trust the result:
- I inspected changed files.
- I inspected artifacts and logs.
- Deterministic validation ran.
- I recorded remaining uncertainty.

Before I create or review a PR:
- The branch is the intended branch.
- The PR summary matches the actual diff.
- Secrets are not present in the diff, artifacts, or logs.
- A human review happens before merge.
```

## Facilitator Preflight

```text
Workshop date:
Archon version or commit:
Operating systems:
Installation path:
Sandbox repository path:
Fallback repository path:
Assistant/provider used:
Provider fallback:
GitHub required: yes / no
Web UI required: yes / no
Known-good health check:
Known-good workflow:
Prepared failure exercise:
Secret-handling reminder reviewed:
```

## Blocker Note

```text
Learner:
Machine or environment:
Command attempted:
Observed output summary:
Evidence inspected:
Likely cause:
Next action:
Owner:
Can continue with fallback: yes / no
```

## Cohort Completion Record

```text
Learner:
Sandbox setup complete:
Safe workflow run complete:
Run report complete:
Custom command complete:
Custom workflow complete:
PIV exercise complete:
Provider routing verified:
GitHub or PR-ready exercise complete:
Capstone complete:
Ready for supervised real repository work: yes / no
Facilitator notes:
```
