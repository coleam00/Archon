---
title: Exercise Bank
description: Reusable Archon curriculum exercises for self-study, workshops, and remediation.
category: learning
audience: [user, operator]
status: current
sidebar:
  order: 9
---

Use this exercise bank when a learner needs more practice than the main tutorial
provides. Every exercise should run in a disposable repository or a low-risk
training repository.

Use [Sandbox Setup Guide](/learning/sandbox-setup/) to prepare the default
repository and the prepared failure repository before assigning these exercises.

## Exercise Format

Each exercise includes:

- Skill practiced.
- Setup.
- Task.
- Evidence to inspect.
- Completion signal.
- Common failure.

## 1. Repository Explanation

Skill practiced: safe read-only workflow operation.

Setup:

- Use the sandbox repository from the practical tutorial.
- Confirm the repository has an initial commit.

Task:

```bash
archon workflow run archon-assist --no-worktree "Explain this repository structure. Do not edit files."
```

Evidence to inspect:

- Workflow status.
- Assistant summary.
- Git status.

Completion signal:

- `git status` shows no unexpected changes.
- Learner can name the files Archon inspected.

Common failure:

- Learner runs from the Archon source repo instead of the sandbox.

## 2. Evidence Hunt

Skill practiced: finding run evidence after output scrolls away.

Setup:

- Complete any safe workflow run.

Task:

Find and record:

```text
Run ID:
Run status:
Worktree or branch:
Artifacts:
Logs:
Changed files:
```

Evidence to inspect:

- CLI status output.
- Filesystem artifacts.
- Git branch or worktree state.

Completion signal:

- Another learner can understand what happened without seeing the original chat
  transcript.

Common failure:

- Learner quotes only the assistant summary and does not inspect files.

## 3. Narrow Custom Command

Skill practiced: command authoring without speculative scope.

Setup:

- Choose one repeated read-only task.
- Create `.archon/commands/` in the sandbox if needed.

Task:

Write a command that asks the assistant to inspect one module and produce a
short report. The command should not request edits.

Evidence to inspect:

- Command file.
- Command validation output.
- Workflow or command run output.
- Git status.

Completion signal:

- The command solves one current task and does not contain secrets.

Common failure:

- Command asks for implementation, review, tests, and PR creation all at once.

## 4. Minimal Workflow

Skill practiced: workflow authoring with deterministic validation.

Setup:

- Use the sandbox repository.
- Start with one agentic node and one validation node.

Task:

Create a workflow that asks for one small implementation and runs a deterministic
validation command.

Evidence to inspect:

- Workflow YAML.
- Validation output.
- Changed files.
- Run report.

Completion signal:

- The workflow validates successfully before it is used on a real repository.

Common failure:

- Workflow depends on hidden chat memory instead of an explicit artifact.

## 5. Approval Gate Drill

Skill practiced: rejecting vague plans.

Setup:

- Use a plan artifact from a previous run or write a small sample plan.

Task:

Decide whether to approve, reject, revise, or defer.

Evidence to inspect:

```text
Does the plan name files?
Does the plan name validation commands?
Does the plan name risks?
Does the plan name rollback steps?
Does the plan fit the request?
```

Completion signal:

- Learner gives a decision with a concrete reason and next instruction.

Common failure:

- Learner approves because the plan "sounds reasonable."

## 6. PR Readiness Drill

Skill practiced: distinguishing PR creation from merge readiness.

Setup:

- Use a sandbox branch with one small change.

Task:

Write a PR readiness note before creating or reviewing a PR.

Evidence to inspect:

- Diff.
- Validation output.
- Artifact summary.
- Secret check.

Completion signal:

- Learner can say what is ready, what remains uncertain, and why merge should
  wait for human review.

Common failure:

- Learner treats passing tests as the only merge criterion.

## 7. Remediation Mini-Exercise

Skill practiced: recovering from a failed learning signal.

Setup:

- Pick one failed completion signal from the curriculum.

Task:

Repeat only the smallest exercise that proves the missing skill.

Evidence to inspect:

- The original failed evidence.
- The corrected evidence.
- The checklist update.

Completion signal:

- Learner can explain what changed in their operating behavior.

Common failure:

- Learner reruns everything without identifying the specific gap.

## 8. Model Role Routing Project

Skill practiced: assigning models by responsibility in a guided coding project.

Setup:

- Complete the Provider Routing Lab first.
- Verify one baseline provider works.
- Verify one inner-development provider privately through Pi, such as Gemini,
  Qwen, Kimi, or a local/custom model.

Task:

Create a tiny workflow or workflow sketch with these roles:

```text
Planner: Claude or Codex
Approval: human
Inner developer: Gemini, Qwen, Kimi, Codex, or Claude
Validation: bash or script node
Reviewer: Claude or Codex
```

Evidence to inspect:

- Plan artifact or node output.
- Approval decision.
- Verified model ID for the inner-development provider.
- Changed files.
- Deterministic validation output.
- Independent review output.
- Rollback path.

Completion signal:

- The learner can explain why each model was assigned to its role.
- Implementation does not start before plan approval.
- Validation result comes from a deterministic command, not an assistant
  summary.

Common failure:

- Learner routes every node to a different model without a job-specific reason.

## 9. Guided Solo Vibe Coding Project

Skill practiced: completing a personal local project with model roles and
evidence.

Setup:

- Use the sandbox repository or a low-risk local repository.
- Choose one small change with a fast validation command.

Task:

Run a supervised project:

```text
1. Claude or Codex writes the plan.
2. Human approves or revises the plan.
3. Gemini, Qwen, Kimi, Codex, or Claude implements the approved scope.
4. A deterministic command validates the result.
5. Claude or Codex reviews the diff and validation output.
6. Human decides keep, revise, or discard.
```

Evidence to inspect:

- Workflow YAML or command sequence.
- Model-role decision note.
- Plan and review artifacts.
- Git diff.
- Validation output.
- Final human decision.

Completion signal:

- Another learner can replay the evidence and understand why the final decision
  was made.

Common failure:

- Learner treats the implementation model's final message as enough evidence.

## 10. Team GitHub Workflow Rehearsal

Skill practiced: team issue-to-PR operation with explicit model roles.

Setup:

- Use a disposable GitHub repository.
- Create one issue with the prepared sandbox change request.
- Confirm `gh auth status` works privately.

Task:

Run or rehearse:

```text
Issue intake -> plan -> approval -> implementation -> validation -> review -> PR-ready branch or PR
```

Assign Claude or Codex to planning and review. Assign Gemini, Qwen, Kimi,
Codex, or Claude to implementation only after its model ID and auth are
verified.

Evidence to inspect:

- Issue reference.
- Branch or worktree.
- Plan approval.
- Implementation provider and fallback.
- Validation output.
- PR readiness note.
- Explicit no-merge statement.

Completion signal:

- The workflow prepares or creates a PR and stops for human review.

Common failure:

- Learner treats PR creation as the end of review.

## 11. Server Or Deployed Team Operation Rehearsal

Skill practiced: operating Archon from a local server, Docker environment, VPS,
or simulated remote setup.

Setup:

- Complete local workflow exercises first.
- Choose one interface: Web UI, GitHub webhook, Slack, Telegram, or Discord.
- Use a sandbox repository and placeholder secrets in shared notes.

Task:

Write and verify a deployment boundary note:

```text
Runtime location:
Database:
Enabled adapter:
Allowed users:
Secrets location:
Health checks:
Log location:
Artifact location:
Rollback:
Incident contact:
```

Then run or simulate one request through the chosen interface.

Evidence to inspect:

- Health endpoint output.
- Adapter or server log summary.
- Workflow run status.
- Artifact location.
- Validation output.
- Recovery or rollback note.

Completion signal:

- The learner can explain where Archon runs, who can trigger it, where evidence
  is stored, and how to stop or recover a risky run.

Common failure:

- Learner exposes an adapter before defining allowed users and secret handling.
