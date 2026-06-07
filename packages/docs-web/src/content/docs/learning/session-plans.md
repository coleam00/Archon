---
title: Workshop Session Plans
description: Facilitator-ready lesson plans for teaching Archon in seven sessions.
category: learning
audience: [operator, user]
status: current
sidebar:
  order: 3
---

Use these session plans when teaching Archon to a team or cohort. Each session
assumes learners have the practical tutorial open, work in a disposable
repository, and keep secrets out of shared notes.

Companion materials:

- [Learner Workbook](/learning/learner-workbook/) for daily learner prompts.
- [Facilitator Evaluation](/learning/facilitator-evaluation/) for scoring and
  sign-off.
- [Cohort Runbook](/learning/cohort-runbook/) for workshop operations.
- [Sandbox Setup Guide](/learning/sandbox-setup/) for resettable training
  repositories.
- [Instructor Notes](/learning/instructor-notes/) for teaching scripts and
  facilitation moves.
- [Sample Artifacts](/learning/sample-artifacts/) for examples learners can
  critique.
- [Exercise Bank](/learning/exercise-bank/) and
  [Troubleshooting Labs](/learning/troubleshooting-labs/) for extra practice.

## Delivery Shape

Default session length: 90 to 120 minutes.

Recommended rhythm:

1. State the session goal.
2. Rehearse the relevant safety rule.
3. Demo the happy path once.
4. Give learners most of the time for hands-on work.
5. Inspect evidence before discussing conclusions.
6. Close with one recovery pattern.

## Session 1: Orientation And Safety

Goal: learners understand Archon as a workflow harness and can name the safety
contract.

Prework:

- Read Practical Tutorial Parts 0 and 1.
- Bring one real workflow idea, but do not use a real repository yet.

Live agenda:

| Time | Activity |
| --- | --- |
| 0-10 min | Define harness, workflow, node, provider, artifact, worktree, adapter, and approval gate. |
| 10-25 min | Compare chat-only coding with repeatable workflow execution. |
| 25-40 min | Walk through the safety contract. |
| 40-65 min | Choose or create each learner's sandbox repository. |
| 65-85 min | Draft each learner's first operating checklist. |
| 85-100 min | Share one safe first workflow idea per learner. |

Lab deliverable:

```text
Archon will:
Git/worktrees will:
The human will approve:
Evidence I will inspect:
```

Facilitator checks:

- The learner does not describe Archon as autonomous merge automation.
- The learner can explain why the first repository is disposable.
- The learner can name at least two kinds of evidence they will inspect after a
  run.

Recovery pattern:

If a learner wants to start in a real project, pause and have them write the
risk boundary for that project. Then move the same task into a disposable repo.

## Session 2: Local Setup Lab

Goal: learners install Archon, verify the CLI, and reach the Web UI.

Prework:

- Read Practical Tutorial Parts 2 and 3.
- Install local prerequisites for the chosen operating system.

Live agenda:

| Time | Activity |
| --- | --- |
| 0-10 min | Confirm shell, Git, Bun, and repository location. |
| 10-30 min | Install or run Archon from the selected path. |
| 30-50 min | Configure the first assistant without exposing secrets. |
| 50-70 min | Start the API and Web UI. |
| 70-90 min | Register or open the sandbox repository. |
| 90-110 min | Run health checks and record setup notes. |

Lab deliverable:

```text
Interface used:
Sandbox path:
CLI check:
Web UI check:
Health check:
Blocker or next action:
```

Facilitator checks:

- The learner never pastes token values into shared chat.
- The CLI and Web UI point at the intended sandbox.
- Any blocked setup has a written next action.

Recovery pattern:

If the Web UI is blocked, keep the learner in the CLI path for the day and
record the exact port, process, or authentication issue to fix later.

## Session 3: First Workflow Lab

Goal: learners run a safe workflow and inspect the evidence it produced.

Prework:

- Read Practical Tutorial Parts 4 and 5.
- Run `archon workflow list` from the sandbox if setup is complete.

Live agenda:

| Time | Activity |
| --- | --- |
| 0-10 min | Review the built-in workflow catalog. |
| 10-25 min | Choose one read-only or low-risk workflow. |
| 25-45 min | Run the workflow in the sandbox. |
| 45-65 min | Inspect status, worktree, logs, and artifacts. |
| 65-85 min | Write a run report. |
| 85-105 min | Compare model claims with validation evidence. |

Lab deliverable:

```text
Workflow:
Command:
Run status:
Files changed:
Worktree or branch:
Artifacts inspected:
Logs inspected:
Safety observation:
```

Facilitator checks:

- The learner distinguishes "the model said it passed" from actual validation
  evidence.
- The learner can find a run again after terminal output scrolls away.
- The learner can identify whether the workflow changed files.

Recovery pattern:

If a run fails, do not restart immediately. Inspect status, logs, artifacts, and
configuration in that order.

## Session 4: Authoring Lab

Goal: learners create one command and one workflow, then validate both.

Prework:

- Read Practical Tutorial Parts 6 and 7.
- Bring one narrow repeated task from the sandbox.

Live agenda:

| Time | Activity |
| --- | --- |
| 0-15 min | Pick a narrow, current use case. |
| 15-35 min | Create a custom command for a read-only or validation task. |
| 35-50 min | Run the command in the sandbox. |
| 50-75 min | Create a minimal YAML workflow. |
| 75-95 min | Add deterministic validation. |
| 95-115 min | Validate command and workflow definitions. |

Lab deliverable:

```text
Command file:
Workflow file:
Task solved:
Validation command:
Validation result:
Known limit:
```

Facilitator checks:

- The workflow has a concrete current use case.
- Validation is deterministic where possible.
- The learner does not add provider routing before the single-provider version
  works.

Recovery pattern:

If the workflow grows too broad, reduce it to one input, one agentic step, one
validation step, and one expected artifact.

## Session 5: Supervised Automation Lab

Goal: learners practice Plan-Implement-Validate with explicit handoffs.

Prework:

- Read Practical Tutorial Parts 8, 9, and 10.
- Identify one small change the sandbox can safely accept.

Live agenda:

| Time | Activity |
| --- | --- |
| 0-15 min | Draw the Plan-Implement-Validate flow. |
| 15-30 min | Decide which node writes the plan artifact. |
| 30-45 min | Decide where human approval belongs. |
| 45-75 min | Run a supervised workflow on the sandbox change. |
| 75-95 min | Review artifacts before implementation and validation after implementation. |
| 95-115 min | Discuss provider routing after the baseline run works. |

Lab deliverable:

```text
Plan artifact:
Approval decision:
Implementation result:
Validation result:
Final human decision:
Provider choice reason:
```

Facilitator checks:

- The learner can say which steps are AI work, deterministic work, and human
  review.
- Artifact handoffs are explicit.
- Provider choices are attached to node responsibility, not model preference.

Recovery pattern:

If a plan is vague, reject it and require concrete files, commands, risks, and
rollback steps before implementation.

## Session 6: Interfaces And Operations

Goal: learners understand GitHub, adapters, deployment boundaries, and recovery
without expanding risk too early.

Prework:

- Read Practical Tutorial Parts 11, 12, and 14.
- Confirm whether GitHub CLI authentication is available for the lab.

Live agenda:

| Time | Activity |
| --- | --- |
| 0-20 min | Practice the local issue-to-PR path or prepare PR steps without pushing. |
| 20-40 min | Review Web UI and adapter boundaries. |
| 40-60 min | Compare local, Docker, and VPS operation. |
| 60-80 min | Review secret handling for GitHub, chat adapters, and provider credentials. |
| 80-105 min | Troubleshoot one prepared failure. |

Lab deliverable:

```text
Where Archon runs:
Enabled interfaces:
Where secrets live:
Who approves PRs:
Deployment boundary:
Recovery path:
```

Facilitator checks:

- The learner separates local CLI use from remote adapter exposure.
- The learner knows which credentials exist and where they must not appear.
- The learner has a recovery path for failed, paused, or unsafe runs.

Recovery pattern:

If learners conflate PR creation with merge readiness, require a PR readiness
note before discussing merge.

## Session 7: Capstone Lab

Goal: learners prove they can operate safely from request to reviewed outcome.

Prework:

- Read Practical Tutorial Parts 15 and 16.
- Choose a capstone option and prepare the sandbox.

Live agenda:

| Time | Activity |
| --- | --- |
| 0-15 min | State the capstone objective and risk boundary. |
| 15-55 min | Run or author the required workflow. |
| 55-80 min | Inspect artifacts, logs, and validation output. |
| 80-100 min | Prepare or create the supervised PR if using the GitHub capstone. |
| 100-115 min | Present evidence and final decision. |
| 115-120 min | Update the operating checklist. |

Lab deliverable:

```text
Objective:
Risk boundary:
Workflow or command:
Evidence inspected:
Validation:
Human decision:
Checklist update:
```

Facilitator checks:

- The learner stops before unsafe merge or deployment.
- The learner can justify approval or rejection from evidence.
- The learner can describe what they would change before using a real
  repository.

Recovery pattern:

If evidence is incomplete, the capstone result is "defer" rather than "pass."
The learner should name the missing evidence and the next validation step.
