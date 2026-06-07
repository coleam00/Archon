---
title: Graduation Checklist
description: Final readiness checklist for Archon learners before supervised real-repository work.
category: learning
audience: [user, operator]
status: current
sidebar:
  order: 27
---

Use this checklist after the capstone. Graduation means the learner is ready for
supervised real-repository work. It does not mean approval gates, validation, or
human review can be removed.

## Learner Readiness

```text
Learner:
Reviewer:
Date:
Capstone option:
Training repository:
Recommended first real repository:
Recommended supervision level:
```

## Required Evidence

The learner must show:

```text
Setup note:
Safe workflow run report:
Custom command or workflow:
Validation evidence:
Approval decision:
Capstone report:
Operating checklist:
Rollback path:
```

## Skill Checklist

| Skill | Ready | Evidence |
| --- | --- | --- |
| Explains Archon as a workflow harness |  |  |
| Protects secrets |  |  |
| Uses sandbox before real work |  |  |
| Runs a safe workflow |  |  |
| Inspects status, logs, artifacts, and changed files |  |  |
| Creates or validates a narrow command/workflow |  |  |
| Reviews plan artifacts before implementation |  |  |
| Runs deterministic validation |  |  |
| Assigns model roles by workflow responsibility |  |  |
| Verifies Gemini, Qwen, Kimi, or other routed model IDs before use |  |  |
| Distinguishes PR readiness from merge readiness |  |  |
| Defines team/server runtime boundaries when remote interfaces are used |  |  |
| Names rollback path |  |  |

## First Real-Repository Boundary

Before a learner moves to a real repository, define:

```text
Repository:
Why this repository is low-risk enough:
First workflow:
What the workflow may change:
Branch or worktree strategy:
Required approval gate:
Required validation:
Provider and model-role rules:
Reviewer:
Rollback path:
Stop conditions:
```

## Stop Conditions

The learner should stop and ask for review if:

- The workflow touches unexpected files.
- Validation fails.
- Artifacts contradict the assistant summary.
- The plan does not name files, validation, risk, or rollback.
- A provider fails or uses an unverified model.
- A routed implementation model has no documented fallback or stop condition.
- A server adapter is reachable before access control and secrets are reviewed.
- Secrets appear in output, artifacts, logs, or diffs.
- The change feels ready to merge but has not been reviewed.

## Graduation Outcomes

| Outcome | Meaning | Next step |
| --- | --- | --- |
| Ready with supervision | Learner can run one low-risk workflow with reviewer oversight. | Schedule first real-repository run. |
| Peer-ready | Learner can also help others inspect evidence. | Pair with a newer learner. |
| Remediation needed | One or more completion signals are weak. | Assign focused remediation. |
| Deferred | Evidence is missing or safety behavior is not reliable. | Repeat capstone later. |

## Graduation Note

```text
Decision:
Reason:
Evidence reviewed:
Allowed workflows:
Required reviewer:
Required validation:
Limits:
Follow-up date:
```

## Reminder

The first real-repository workflow should be boring. Choose a small, reversible
task with clear validation. Confidence should come from evidence, not from the
assistant sounding confident.
