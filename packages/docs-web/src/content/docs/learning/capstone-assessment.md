---
title: Capstone Assessment
description: Capstone options, deliverables, scoring rubric, and sign-off questions for Archon learners.
category: learning
audience: [user, operator]
status: current
sidebar:
  order: 5
---

Use a capstone to decide whether a learner is ready to use Archon on a real
project with supervision. The goal is operating judgment, not memorizing command
syntax.

Use [Facilitator Evaluation](/learning/facilitator-evaluation/) to record the
final score, red flags, sign-off boundary, and any remediation assignment.
After a learner passes, use
[Graduation Checklist](/learning/graduation-checklist/) and
[Real Repository Transition](/learning/real-repository-transition/) to define
the first supervised real-repository run.

## Required Safety Boundary

Every capstone starts with these rules:

- Use a disposable repository or a low-risk training repository.
- Keep secrets out of chat, shared notes, logs, artifacts, and diffs.
- Use an isolated branch or worktree for modifying work.
- Validate custom commands and workflows before running them.
- Stop before autonomous merge or deployment.
- Record the evidence used for the final decision.

## Capstone Options

| Option | Best for | Required outcome |
| --- | --- | --- |
| Local operator | Learners who will run existing workflows | Run a built-in workflow, inspect logs and artifacts, and write a run report. |
| Workflow author | Learners who will create automation | Build a supervised Plan-Implement-Validate workflow with at least one approval gate. |
| Provider router | Learners using multiple assistants | Verify a single-provider baseline, then route one node to another provider with a written reason. |
| Model-role project operator | Learners using Claude/Codex for planning or testing and Gemini/Qwen/Kimi/Codex/Claude for inner development | Complete a guided project with explicit model roles, artifact handoffs, deterministic validation, and independent review. |
| GitHub operator | Learners using issues and PRs | Prepare or create a supervised pull request from an issue and stop before merge. |
| Team remote operator | Teams running Archon through GitHub, chat adapters, Docker, VPS, or a server | Verify runtime boundary, adapter exposure, health checks, logs, artifacts, rollback, and supervised workflow execution. |

## Required Deliverables

Every capstone must produce:

- A run report.
- The command or workflow definition used, if custom.
- Relevant artifact paths or summaries.
- Logs inspected.
- Validation evidence.
- A human decision: approve, reject, revise, or defer.
- One operating-checklist update based on the run.

GitHub capstones also require:

- Issue or request reference.
- Branch name.
- PR link or PR-ready branch note.
- Manual review notes.
- Explicit statement that no autonomous merge was performed.

Model-role capstones also require:

- Planner provider and model.
- Inner-development provider and verified model ID.
- Reviewer or test-strategy provider.
- Artifact passed across each model boundary.
- Fallback provider or stop condition if the routed model is unavailable.
- Explanation of why the chosen implementation model was appropriate.

Team remote capstones also require:

- Runtime location: local server, Docker, VPS, or simulated remote.
- Enabled interface or adapter.
- Allowed users or access boundary.
- Secret-handling note.
- Health check evidence.
- Log and artifact locations.
- Rollback or incident response note.

## Scoring Rubric

Score each category from 1 to 3. A score of 2 in every category is the minimum
for supervised real-repository work. A score of 3 indicates the learner can help
others.

| Category | 1 - Needs practice | 2 - Ready with supervision | 3 - Strong operator |
| --- | --- | --- | --- |
| Safety boundary | Uses the sandbox inconsistently or exposes risky details. | Uses sandbox, protects secrets, and keeps approval gates. | Adjusts safety boundaries based on repository and task risk. |
| Workflow execution | Can run a command only by following exact steps. | Runs workflows and finds status, logs, worktrees, and artifacts. | Diagnoses run state and explains evidence to others. |
| Authoring | Creates unclear commands or workflows that depend on hidden assumptions. | Creates a narrow command and workflow with validation. | Designs clean artifact handoffs and rollback-friendly workflow shapes. |
| Validation | Relies on model summaries. | Runs deterministic checks and records results. | Chooses validation that matches the risk and knows when evidence is incomplete. |
| Approval | Approves or rejects without a clear reason. | Reviews plan and output before moving forward. | Gives actionable revision instructions at approval gates. |
| Model-role routing | Routes by model preference or novelty. | Assigns models by node responsibility and verifies model IDs. | Designs fallback behavior and independent review for routed workflows. |
| GitHub practice | Pushes or merges too early. | Prepares or creates a supervised PR and stops for review. | Produces a clear PR readiness note with residual risks. |
| Team/server operation | Cannot explain where Archon runs or who can trigger it. | Defines runtime, adapter exposure, health checks, logs, and rollback. | Operates a supervised remote flow and records incident-ready evidence. |

## Sign-Off Questions

Before graduating a learner, ask:

1. What repository would you use next, and why is it low risk enough?
2. Which workflow will you run first, and what could it change?
3. Where will artifacts and logs appear?
4. What validation must pass before you trust the result?
5. Where are secrets stored, and what should never be pasted into chat?
6. What approval gate would make you reject or revise the run?
7. What is your rollback path if the generated change is wrong?

The learner does not need perfect answers. They need evidence-based answers and
a willingness to stop when the evidence is weak.

## Pass, Revise, Or Defer

Use these outcomes:

| Outcome | Meaning | Next step |
| --- | --- | --- |
| Pass | The learner met every safety and evidence requirement. | Move to supervised real-repository work. |
| Revise | The workflow or report is close, but one decision or artifact needs correction. | Repeat the narrow failed section. |
| Defer | Evidence is missing, secrets were mishandled, or the learner cannot explain the risk boundary. | Return to the relevant session and repeat the capstone later. |

Do not graduate a learner by removing safety gates. Graduate them by showing
they know which gates still matter and why.
