---
title: Publishing Checklist
description: Final checks before publishing or teaching the Archon curriculum.
category: learning
audience: [developer, operator]
status: current
sidebar:
  order: 22
---

Use this checklist before publishing the curriculum or running a live cohort.

## Source-Backed Content

```text
Practical tutorial reviewed:
Curriculum guide reviewed:
Learning index reviewed:
Reading map reviewed:
CLI examples verified:
Workflow examples verified:
Provider examples verified:
GitHub examples verified:
Deployment boundaries verified:
```

## Safety Review

```text
Sandbox-first guidance present:
Secret-handling warnings present:
Human approval guidance present:
No autonomous merge recommendation:
No production deployment in beginner path:
Provider routing requires baseline:
PR creation distinguished from merge readiness:
Validation distinguished from assistant summary:
```

## Navigation Review

```text
Learning section appears in sidebar:
Learning index links every major curriculum page:
Package map includes every major curriculum asset:
Quick-start paths cover common roles:
Homepage links learning materials:
Reading map covers learner roles:
Session plans link workbook and evaluation:
Cohort runbook links setup and labs:
Capstone links evaluation:
```

## Facilitator Readiness

```text
Syllabus available:
Session plans available:
Instructor notes available:
Slide outline available:
Sandbox setup guide available:
Sample artifacts available:
Knowledge checks available:
FAQ available:
Evaluation sheet available:
Capstone rubric available:
```

## Sandbox Readiness

```text
Resettable sandbox repository prepared:
Prepared failure repository prepared:
Known-good workflow selected:
Known-good validation command selected:
Provider fallback selected:
GitHub optional path decided:
No secrets in sandbox:
Reset path tested:
```

## Build And Route Check

Run:

```bash
bun --filter @archon/docs-web build
```

Confirm the generated routes include:

```text
/learning/
/learning/practical-tutorial/
/learning/curriculum/
/learning/session-plans/
/learning/learner-workbook/
/learning/capstone-assessment/
/learning/sandbox-setup/
/learning/knowledge-checks/
/learning/faq/
```

## Review Sign-Off

```text
Reviewer:
Date:
Archon version or commit:
Docs build result:
Known limitations:
Approved for publishing: yes / no
Approved for live cohort: yes / no
```

## If Publishing Is Blocked

Record:

```text
Blocking issue:
Affected page:
Risk:
Owner:
Next action:
```

Do not publish if the blocker affects safety, secrets, validation, or unsupported
command behavior.
