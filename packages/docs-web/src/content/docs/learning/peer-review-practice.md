---
title: Peer Review Practice
description: Structured peer-review exercises for Archon curriculum learners.
category: learning
audience: [user, operator]
status: current
sidebar:
  order: 26
---

Peer review helps learners practice evidence inspection without relying on the
facilitator for every decision. Use these exercises after learners have
completed at least one run report.

## Peer Review Rules

- Review evidence, not personality.
- Ask for missing evidence before giving advice.
- Do not request secrets.
- Do not approve merge during beginner practice.
- Write down the decision.

## Pair Review Format

Learner A presents:

```text
Workflow or command:
Repository:
Branch or worktree:
Request:
Changed files:
Artifacts:
Logs:
Validation:
Human decision:
Question for reviewer:
```

Learner B reviews:

```text
Evidence I could verify:
Evidence missing:
Risk I see:
Suggested decision:
Checklist update:
```

Then switch roles.

## Review Exercise 1: Run Report Review

Goal:

- Determine whether a run report is complete enough for another person to
  understand the run.

Reviewer checks:

- Repository and branch are named.
- Changed files are named or explicitly "none."
- Artifacts and logs are mentioned.
- Validation output is summarized.
- Human decision is clear.

Decision:

```text
accept / revise / defer
```

## Review Exercise 2: Approval Review

Goal:

- Practice approving or rejecting a plan artifact.

Reviewer checks:

- Files are named.
- Validation is named.
- Risk is named.
- Rollback is named.
- Scope matches the request.

Decision:

```text
approve / reject / revise / defer
```

## Review Exercise 3: PR Readiness Review

Goal:

- Decide whether a branch is ready for PR review, not merge.

Reviewer checks:

- Diff summary matches changed files.
- Validation evidence exists.
- Artifacts support the summary.
- Secrets are not present in shared evidence.
- Manual review concern is named.

Decision:

```text
ready for PR review / revise branch / defer / stop
```

## Reviewer Prompts

Use these prompts:

```text
What evidence did you inspect directly?
What did the assistant claim?
Which claim is confirmed?
Which claim remains uncertain?
What would make you stop?
What is the rollback path?
```

## Peer Review Note

```text
Presenter:
Reviewer:
Artifact reviewed:
Evidence present:
Evidence missing:
Decision:
Revision request:
Checklist update:
```

## Facilitator Use

Use peer review when:

- The group is large.
- Learners need more evidence practice.
- Office hours are overloaded.
- A learner needs remediation but not a full facilitator review.

Do not use peer review as the only capstone assessment. A facilitator or
designated reviewer should still sign off on real-repository readiness.
