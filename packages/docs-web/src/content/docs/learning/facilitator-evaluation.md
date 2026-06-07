---
title: Facilitator Evaluation
description: Evaluation sheets and review prompts for assessing Archon curriculum learners.
category: learning
audience: [operator]
status: current
sidebar:
  order: 7
---

Use this page to evaluate whether a learner can use Archon safely with
supervision. Assessment should measure evidence-based operating judgment, not
memorized commands.

If a learner misses a completion signal, assign a focused path from
[Remediation Playbook](/learning/remediation-playbook/). For lightweight
practice before sign-off, use
[Peer Review Practice](/learning/peer-review-practice/).
When the learner is ready, complete
[Graduation Checklist](/learning/graduation-checklist/).
Use [Learning Outcomes Matrix](/learning/outcomes-matrix/) when you need to map
weak evidence to targeted remediation.

## Evaluation Summary

```text
Learner:
Evaluator:
Date:
Archon version or commit:
Training repository:
Capstone option:
Overall result: pass / revise / defer
Recommended next workflow:
Recommended supervision level:
```

## Evidence Checklist

| Evidence | Required | Observed |
| --- | --- | --- |
| Disposable or low-risk repository used | yes |  |
| Secrets kept out of chat, notes, logs, artifacts, and diffs | yes |  |
| CLI or Web UI setup verified | yes |  |
| Safe workflow run completed | yes |  |
| Run status inspected | yes |  |
| Worktree or branch inspected | yes |  |
| Logs inspected | yes |  |
| Artifacts inspected | yes |  |
| Custom command or workflow validated | yes, for authoring track |  |
| Approval decision explained | yes |  |
| Deterministic validation recorded | yes |  |
| PR stopped before merge | yes, for GitHub track |  |

## Scoring

Score each category from 1 to 3.

| Category | Score | Notes |
| --- | --- | --- |
| Safety boundary |  |  |
| Workflow execution |  |  |
| Evidence inspection |  |  |
| Workflow authoring |  |  |
| Validation judgment |  |  |
| Approval judgment |  |  |
| Provider routing judgment |  |  |
| GitHub readiness |  |  |
| Communication |  |  |

Suggested interpretation:

- Mostly 1s: repeat the relevant sessions before real project work.
- All 2s or better: ready for supervised real-repository work.
- Mostly 3s: ready to help other learners inspect evidence and review runs.

## Review Prompts

Ask the learner:

1. What did Archon do in this run?
2. What did Git isolate?
3. What changed on disk?
4. Which evidence did you inspect?
5. Which validation result matters most?
6. Which model or provider claim did you not fully trust?
7. Why did you approve, reject, revise, or defer?
8. What would make this unsafe in a real repository?
9. What is the rollback path?
10. What checklist item changed because of this run?

## Red Flags

Defer graduation if any of these happen:

- Learner exposes or copies secrets into shared materials.
- Learner cannot identify the repository or branch used.
- Learner trusts the assistant summary without inspecting files or validation.
- Learner approves a vague plan with no files, commands, risks, or rollback.
- Learner routes providers by model preference before a baseline works.
- Learner treats PR creation as merge readiness.
- Learner wants to remove safety gates to move faster.

## Sign-Off Note

```text
The learner is ready to use Archon on:

Repository type:
Allowed workflows:
Required approval gates:
Required validation:
Provider limits:
GitHub limits:
Supervision required:
Follow-up date:
```

## Remediation Assignment

```text
Gap:
Session to repeat:
Exercise:
Evidence required:
Due date:
Reviewer:
```
