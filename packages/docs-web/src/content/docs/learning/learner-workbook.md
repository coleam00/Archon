---
title: Learner Workbook
description: Day-by-day workbook prompts for completing the Archon curriculum safely.
category: learning
audience: [user]
status: current
sidebar:
  order: 6
---

Use this workbook while following the practical tutorial or attending a
workshop. Keep it in a private notebook or a safe shared training space. Do not
record secrets, token values, provider auth files, or full `.env` contents.

For extra practice, use the [Exercise Bank](/learning/exercise-bank/). If you
get blocked, use the [Troubleshooting Labs](/learning/troubleshooting-labs/) to
practice inspecting evidence before rerunning.

## Before You Start

Write your starting boundary:

```text
My training repository:
Why it is safe enough:
Assistant/provider I will use first:
Interface I will use first: CLI / Web UI / both
What I will not automate yet:
Where I will store notes:
```

Write your safety promise:

```text
I will keep secrets out of chat and shared notes.
I will use a disposable repository until I can inspect evidence from a run.
I will use isolated branches or worktrees for modifying workflows.
I will validate custom commands and workflows before running them.
I will review generated PRs before merge.
```

## Day 1: Orientation

Read:

- Practical Tutorial Parts 0 and 1.

Practice:

- Explain Archon as a harness, not a bigger prompt.
- Choose your first safe path.

Workbook:

```text
My one-sentence harness goal:
Three terms I can explain:
The first repository I will use:
Why I am not using a production repository yet:
Approval gate I expect to need:
Question to revisit:
```

Completion signal:

- You can explain why workflows, artifacts, worktrees, validation, and approval
  gates make AI coding more repeatable.

## Day 2: Setup

Read:

- Practical Tutorial Parts 2 and 3.

Practice:

- Install or run Archon.
- Verify CLI and Web UI access.
- Create or register the sandbox repository.

Workbook:

```text
Archon version or commit:
Operating system and shell:
Sandbox path:
CLI check result:
Web UI check result:
Health check result:
Provider configured:
Setup blocker:
Next action:
```

Completion signal:

- CLI and Web UI both point at the intended sandbox, or you have a documented
  blocker with a next action.

## Day 3: First Workflow

Read:

- Practical Tutorial Parts 4 and 5.

Practice:

- Run one safe workflow.
- Inspect status, worktree or branch, logs, artifacts, and changed files.

Workbook:

```text
Workflow:
Command:
Request:
Run status:
Files changed:
Worktree or branch:
Artifact evidence:
Log evidence:
Validation evidence:
What I trust:
What I do not trust yet:
```

Completion signal:

- You can find evidence after a run without relying only on the assistant's
  summary.

## Day 4: Authoring

Read:

- Practical Tutorial Parts 6 and 7.

Practice:

- Create one custom command.
- Create one minimal custom workflow.
- Validate both.

Workbook:

```text
Repeated task:
Command file:
Workflow file:
Input:
Expected artifact:
Validation command:
Validation result:
Authoring mistake I fixed:
Known limit:
```

Completion signal:

- You have one narrow command and one narrow workflow that solve a current
  sandbox problem.

## Day 5: Supervised Automation

Read:

- Practical Tutorial Parts 8, 9, and 10.

Practice:

- Run or build a Plan-Implement-Validate flow.
- Approve, reject, revise, or defer from evidence.
- Try provider routing only after a single-provider baseline works.

Workbook:

```text
Plan artifact:
Plan quality: approve / reject / revise / defer
Approval reason:
Implementation result:
Validation command:
Validation result:
Final decision:
Provider routing used:
Provider routing reason:
```

Completion signal:

- You can explain which steps are AI reasoning, which steps are deterministic
  validation, and which decisions belong to a human.

## Day 6: GitHub And Operations

Read:

- Practical Tutorial Parts 11, 12, and 14.

Practice:

- Prepare or create a supervised PR from a safe issue.
- Review adapter and deployment boundaries.
- Troubleshoot one failure from evidence.

Workbook:

```text
Issue or request:
Branch:
PR link or PR-ready branch:
Enabled interfaces:
Where Archon runs:
Where secrets live:
Validation evidence:
Manual review concern:
No autonomous merge performed: yes / no
Troubleshooting evidence inspected:
```

Completion signal:

- You can distinguish PR creation from merge readiness.

## Day 7: Capstone

Read:

- Practical Tutorial Parts 15 and 16.
- Capstone Assessment.

Practice:

- Complete one capstone option.
- Present evidence and final decision.
- Update your operating checklist.

Workbook:

```text
Capstone option:
Objective:
Risk boundary:
Workflow or command:
Artifacts inspected:
Logs inspected:
Validation:
Human decision:
Checklist update:
What I would change before using a real repository:
```

Completion signal:

- You can show evidence for a safe final decision and name what you would do
  differently before using Archon on a real project.

## Final Reflection

```text
The first real repository I might use:
Why it is low-risk enough:
The first workflow I would run:
What it could change:
Validation required:
Approval gate required:
Rollback path:
Remaining risks:
```
