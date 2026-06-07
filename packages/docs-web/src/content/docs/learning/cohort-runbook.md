---
title: Cohort Runbook
description: Operational runbook for preparing and running an Archon learning cohort.
category: learning
audience: [operator]
status: current
sidebar:
  order: 8
---

Use this runbook when preparing a group training. It keeps operational details
separate from the curriculum so the class can focus on learning Archon safely.

Pair this runbook with [Workshop Session Plans](/learning/session-plans/),
[Sandbox Setup Guide](/learning/sandbox-setup/), the
[Instructor Notes](/learning/instructor-notes/),
[Sample Artifacts](/learning/sample-artifacts/), the
[Exercise Bank](/learning/exercise-bank/), and
[Troubleshooting Labs](/learning/troubleshooting-labs/). Before teaching, run
the [Publishing Checklist](/learning/publishing-checklist/).
Use [Printable Checklist Pack](/learning/printable-checklists/) during live
sessions.
Use [Office Hours Guide](/learning/office-hours-guide/) for between-session
support and [Remediation Playbook](/learning/remediation-playbook/) when
learners miss completion signals.
After the cohort, complete [Cohort Report](/learning/cohort-report/) and review
[Curriculum Metrics](/learning/curriculum-metrics/).

## Two Weeks Before

- Choose the delivery track: self-study support, workshop, or hybrid.
- Pick the installation path learners will use.
- Choose the first assistant/provider and one fallback.
- Decide whether GitHub authentication is required during the cohort.
- Create a resettable sandbox repository.
- Create a second sandbox repository with one prepared failure.
- Confirm the Web UI can run on the target machines or provide a CLI-only
  fallback.
- Decide where learners will keep notes.
- Publish the safety contract.

## One Week Before

- Verify the selected Archon version or commit.
- Run the practical tutorial setup path on a clean machine.
- Run one known-good workflow in the sandbox.
- Prepare a sample plan artifact that should be approved.
- Prepare a sample plan artifact that should be rejected.
- Prepare a sanitized run log excerpt.
- Prepare a sanitized PR readiness note.
- Confirm no training material contains secrets.

## One Day Before

```text
Archon version or commit:
Install command or source path:
Sandbox repository:
Prepared failure repository:
Known-good workflow:
Known-good validation command:
Web UI URL:
Provider fallback:
GitHub fallback:
Support channel:
```

Send learners:

- Session schedule.
- Prerequisites.
- Safety contract.
- Prework reading.
- Setup expectations.
- What not to share.

## During Each Session

Use this operator loop:

1. State the goal.
2. Repeat the safety rule.
3. Demo the happy path once.
4. Put learners in the driver seat.
5. Ask for evidence, not impressions.
6. Record blockers with owners.
7. Close with the next checklist update.

## Blocker Triage

| Blocker | Keep learner moving with | After-session fix |
| --- | --- | --- |
| CLI missing | Pair with another learner for evidence inspection | Fix PATH or install path |
| Provider auth unavailable | Use read-only docs and workflow authoring exercises | Configure provider privately |
| Web UI unavailable | Continue with CLI workflow status and logs | Resolve port or browser issue |
| GitHub unavailable | Prepare PR-ready branch note instead of creating PR | Finish `gh auth` later |
| Workflow fails | Inspect status, logs, artifacts, and config | Preserve evidence for review |

## Cohort Dashboard

```text
Learner:
Setup:
First workflow:
Run report:
Custom command:
Custom workflow:
PIV:
GitHub/PR:
Capstone:
Current blocker:
Next action:
```

## Evidence Collection Policy

Collect:

- Run reports.
- Workflow design briefs.
- PR readiness notes.
- Final operating checklists.
- Sanitized screenshots only when they do not show secrets.

Do not collect:

- API keys.
- OAuth tokens.
- Provider auth files.
- Full `.env` contents.
- Raw logs that have not been inspected for secrets.

## After The Cohort

- Review capstone assessments.
- Assign remediation where needed.
- Decide which learners are ready for supervised real-repository work.
- Archive sanitized examples.
- Update the sandbox repositories.
- Record curriculum corrections for the next cohort.

## Retrospective Prompts

Ask facilitators:

1. Which setup step blocked the most learners?
2. Which safety rule needed the most repetition?
3. Which workflow produced the clearest learning evidence?
4. Which exercise was too broad?
5. Which docs page should be improved before the next cohort?
6. Which capstone outcomes were deferred, and why?

Ask learners:

1. Where did Archon feel most useful?
2. Where did you almost trust output without evidence?
3. Which approval gate helped most?
4. What do you still need before using Archon on a real repository?
