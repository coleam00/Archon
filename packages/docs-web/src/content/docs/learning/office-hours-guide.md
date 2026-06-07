---
title: Office Hours Guide
description: How to run Archon curriculum office hours without turning them into unstructured debugging.
category: learning
audience: [operator, user]
status: current
sidebar:
  order: 24
---

Use office hours to unblock learners while preserving the curriculum's evidence
habits. The goal is not to fix everything live. The goal is to teach learners
how to inspect, explain, and recover.

## Office Hours Format

Default format:

1. Learner states the goal.
2. Learner states the safety boundary.
3. Learner shows sanitized evidence.
4. Facilitator asks evidence-first questions.
5. Learner chooses the next action.
6. Learner records the decision.

Keep each case to 10 to 15 minutes. If the issue needs more time, turn it into
a blocker note with an owner.

## What Learners Should Bring

Ask learners to bring:

```text
Repository:
Branch or worktree:
Workflow or command:
Request:
Run status:
Artifact inspected:
Log inspected:
Validation command:
Validation result:
Question:
```

They should not bring:

- API keys.
- OAuth tokens.
- Provider auth files.
- Full `.env` contents.
- Raw logs that have not been inspected for secrets.

## Triage Questions

Ask in this order:

1. What were you trying to do?
2. What repository did Archon use?
3. What branch or worktree did it use?
4. What changed on disk?
5. What artifact did you inspect?
6. What log did you inspect?
7. What validation ran?
8. What did the assistant claim?
9. What evidence confirms or contradicts that claim?
10. What decision are you considering?

## Common Office Hours Cases

| Case | Response |
| --- | --- |
| Setup blocked | Record exact command and output summary, assign owner, move learner to workbook or evidence review. |
| Workflow failed | Inspect status, logs, artifacts, and changed files before rerunning. |
| Plan is vague | Require a revision request that names files, validation, risk, and rollback. |
| Provider unavailable | Fall back to a single-provider baseline and verify provider setup privately later. |
| PR feels ready | Require a PR readiness note and human review before merge. |
| Learner wants real repo | Ask for risk boundary, validation, approval gate, and rollback path first. |

## Decision Outcomes

Every office-hours case should end with one outcome:

| Outcome | Meaning |
| --- | --- |
| Continue | Learner has enough evidence and a safe next step. |
| Revise | Learner needs to change a command, workflow, plan, or request. |
| Remediate | Learner should repeat a specific exercise. |
| Defer | Evidence is missing or risk is too high. |
| Escalate | A maintainer, operator, or provider-specific expert is needed. |

## Office Hours Note

```text
Learner:
Date:
Goal:
Safety boundary:
Evidence shown:
Missing evidence:
Decision:
Next action:
Owner:
Follow-up needed:
```

## Facilitator Boundaries

Do:

- Ask for evidence.
- Keep secrets out of shared spaces.
- Prefer small next steps.
- Record blockers.
- Assign remediation when a skill gap is visible.

Do not:

- Take over the learner's terminal for the whole session.
- Debug provider credentials in shared view.
- Approve vague plans to save time.
- Encourage merge or deployment during beginner support.
- Let office hours replace the capstone.

## Closing Prompt

End with:

```text
What will you do next?
What evidence will prove it worked?
What will make you stop?
```
