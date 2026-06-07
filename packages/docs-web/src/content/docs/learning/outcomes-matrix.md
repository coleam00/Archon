---
title: Learning Outcomes Matrix
description: Curriculum outcomes mapped to evidence, exercises, assessment, and remediation.
category: learning
audience: [operator, user]
status: current
sidebar:
  order: 30
---

Use this matrix to connect curriculum goals to observable evidence. It helps
facilitators avoid vague pass/fail decisions.

## Outcome Levels

| Level | Meaning |
| --- | --- |
| Introduced | Learner has seen the concept and can define it with help. |
| Practiced | Learner has completed a sandbox exercise. |
| Demonstrated | Learner can show evidence without prompting. |
| Ready | Learner can apply the skill in supervised real-repository work. |

## Outcomes

| Outcome | Evidence | Practice | Assessment | Remediation |
| --- | --- | --- | --- | --- |
| Explain Archon as a harness | Harness goal, glossary use | Orientation workbook | Knowledge check Unit 1 | Re-read glossary and write a one-sentence harness goal |
| Protect secrets | No secrets in notes, logs, artifacts, or diffs | Setup workbook | Facilitator evidence checklist | Safety gap remediation |
| Use sandbox first | Training repository and risk boundary | Sandbox setup | Graduation checklist | Sandbox boundary prompt |
| Run safe workflow | Run report | Repository explanation exercise | Capstone local operator option | Evidence hunt |
| Inspect evidence | Status, logs, artifacts, changed files | Evidence hunt | Run report review | Evidence inspection remediation |
| Author narrow command/workflow | Validated command or workflow | Authoring lab | Workflow author capstone | Authoring remediation |
| Review approval gate | Approval review note | Approval gate drill | Supervised automation lab | Approval judgment remediation |
| Run deterministic validation | Validation command and result | Minimal workflow exercise | Capstone report | Validation note review |
| Route providers intentionally | Baseline and routing decision note | Provider routing lab | Provider router capstone | Provider routing remediation |
| Assign model roles in guided projects | Model-role decision note, verified model IDs, artifact handoffs | Model role routing project | Model-role project operator capstone | Repeat baseline and justify one routed node |
| Prepare supervised PR | PR readiness note | PR readiness drill | GitHub operator capstone | GitHub readiness remediation |
| Operate team/server boundary | Runtime boundary note, health checks, logs, artifacts, rollback | Server or deployed team operation rehearsal | Team remote operator capstone | Repeat local flow and document adapter exposure |
| Transition to real repository | Graduation checklist and reviewer boundary | Capstone | Real repository transition review | Repeat capstone or focused remediation |

## Evidence Quality

Good evidence is:

- Specific.
- Secret-free.
- Inspectable by another person.
- Tied to a human decision.
- Clear about what it does not prove.

Weak evidence is:

- Only an assistant summary.
- Missing repository or branch context.
- Missing validation output.
- Missing changed files.
- Missing stop condition or rollback.

## Matrix Review

Before graduating a learner, pick one row where the learner is weakest and ask:

```text
What evidence proves this skill?
Who inspected it?
What would make this evidence insufficient?
What remediation would prove the skill?
```

## Team Use

For a cohort, aggregate by outcome:

```text
Outcome:
Learners ready:
Learners needing remediation:
Common evidence gap:
Curriculum page to improve:
```

Use the aggregate to improve the curriculum, not to shame learners.
