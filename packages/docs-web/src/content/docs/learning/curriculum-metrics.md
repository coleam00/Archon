---
title: Curriculum Metrics
description: Practical metrics for evaluating Archon curriculum effectiveness without encouraging unsafe behavior.
category: learning
audience: [operator]
status: current
sidebar:
  order: 32
---

Use metrics to improve the curriculum, not to pressure learners into rushing.
The safest metric is not "how fast did the model produce code." The safest
metric is "did learners make evidence-backed decisions?"

## Measurement Principles

- Measure evidence quality.
- Measure safety behavior.
- Measure remediation needs.
- Measure repeated blockers.
- Do not reward skipped approval gates.
- Do not reward autonomous merge during learning.

## Recommended Metrics

| Metric | Why it matters |
| --- | --- |
| Setup completion rate | Shows whether prerequisites and setup docs are clear. |
| First workflow completion rate | Shows whether learners can run Archon safely. |
| Run report completion rate | Shows whether learners inspect evidence. |
| Approval rejection quality | Shows whether learners can stop vague plans. |
| Validation recording rate | Shows whether deterministic checks are treated seriously. |
| Capstone pass/revise/defer rate | Shows readiness distribution. |
| Remediation completion rate | Shows whether support paths work. |
| Secret-handling incidents | Shows safety risk. |
| Wrong-repository incidents | Shows context and workflow-starting risk. |
| PR readiness errors | Shows GitHub readiness gaps. |

## Metrics To Avoid

Avoid using:

- Lines of code generated.
- Number of workflows run without context.
- Fastest completion time.
- Number of PRs created.
- Number of providers used.

These can reward unsafe behavior if used without evidence quality.

## Cohort Metrics Template

```text
Cohort:
Learners:
Setup completed:
First workflow completed:
Run reports completed:
Custom commands/workflows completed:
PIV exercises completed:
Capstones passed:
Capstones revised:
Capstones deferred:
Remediation assigned:
Remediation completed:
Secret incidents:
Wrong-repository incidents:
PR readiness issues:
Most common blocker:
Most useful curriculum page:
Page needing revision:
```

## Evidence Quality Score

Use this simple scale:

| Score | Meaning |
| --- | --- |
| 1 | Evidence mostly repeats assistant claims. |
| 2 | Evidence includes status, files, artifacts/logs, and validation. |
| 3 | Evidence also names uncertainty, risk, decision, and rollback. |

Use the score for coaching, not ranking.

## Safety Signal Review

After each cohort, ask:

```text
Did anyone expose secrets?
Did anyone use a real repository too early?
Did anyone skip isolation for modifying work?
Did anyone approve a vague plan?
Did anyone treat PR creation as merge readiness?
Did anyone route providers before baseline?
```

Any "yes" should become a curriculum improvement or remediation assignment.

## Improvement Loop

1. Collect cohort report.
2. Identify repeated blockers.
3. Update FAQ, troubleshooting labs, or session plans.
4. Re-run docs build.
5. Record changes in maintenance notes.

Metrics are useful only when they change the next cohort for the better.
