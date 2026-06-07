---
title: Curriculum Syllabus
description: A course-style syllabus for teaching Archon from first install to supervised workflow operation.
category: learning
audience: [user, operator]
status: current
sidebar:
  order: 12
---

Use this syllabus when running Archon as a structured course. It defines the
course promise, audience, prerequisites, schedule, grading model, and completion
requirements.

## Course Promise

By the end of this course, learners can use Archon as a supervised AI coding
workflow harness: install it, run safe workflows, inspect evidence, author small
commands and workflows, route providers intentionally, prepare pull requests,
and stop before unsafe merge or deployment.

## Audience

This course is for:

- Developers learning Archon for personal workflow automation.
- Team leads preparing safe onboarding for AI-assisted development.
- Operators responsible for local, Docker, or remote Archon environments.
- Facilitators running a cohort or internal enablement workshop.

This course is not for:

- Unsupervised production automation.
- Autonomous issue-to-merge pipelines.
- Secret management training beyond Archon-specific safety boundaries.
- Advanced workflow engineering before learners can inspect basic run evidence.

## Prerequisites

Learners should have:

- Basic Git comfort: commits, branches, remotes, diffs, and pull requests.
- A local shell that can run the selected Archon setup path.
- Access to the chosen assistant/provider.
- A disposable repository for early exercises.
- A private place to keep run notes.

Facilitators should also have:

- A resettable sandbox repository.
- A prepared failure repository.
- A provider fallback.
- A policy for secrets, GitHub tokens, and shared notes.

## Required Materials

- [Practical Tutorial](/learning/practical-tutorial/)
- [Curriculum Guide](/learning/curriculum/)
- [Learner Workbook](/learning/learner-workbook/)
- [Workshop Session Plans](/learning/session-plans/)
- [Exercise Bank](/learning/exercise-bank/)
- [Model Role Recipes](/learning/model-role-recipes/)
- [Knowledge Checks](/learning/knowledge-checks/)
- [Capstone Assessment](/learning/capstone-assessment/)
- [Graduation Checklist](/learning/graduation-checklist/)
- [Real Repository Transition](/learning/real-repository-transition/)

## Schedule

| Unit | Topic | Tutorial parts | Evidence due |
| --- | --- | --- | --- |
| 1 | Orientation and safety | 0-1 | Harness goal and safety boundary |
| 2 | Local setup | 2-3 | CLI/Web UI setup note |
| 3 | First workflow | 4-5 | Run report with logs and artifacts |
| 4 | Authoring basics | 6-7 | One validated command and workflow |
| 5 | Supervised automation | 8-10 | Plan artifact, approval decision, validation output |
| 6 | GitHub, model roles, and operations | 11-14 plus Model Role Recipes | PR readiness, model-role decision, or deployment boundary note |
| 7 | Capstone | 15-16 | Capstone report and operating checklist |

## Attendance And Participation

Learners should attend live labs or complete the equivalent workbook prompts.
Participation means showing evidence from runs, not merely reporting that a
command was executed.

Expected participation:

- Keep secrets out of shared spaces.
- Use the sandbox until completion criteria are met.
- Share sanitized run reports.
- Ask for review before risky operations.
- Update the personal operating checklist after each unit.

## Assessment

Assessment is evidence-based. Learners pass by demonstrating safe operation,
not by memorizing commands.

Required evidence:

- Setup note.
- Safe workflow run report.
- Custom command or workflow validation.
- Approval gate decision.
- Deterministic validation result.
- Model-role decision note when using multiple models.
- Capstone report.
- Final operating checklist.

Use [Facilitator Evaluation](/learning/facilitator-evaluation/) and
[Capstone Assessment](/learning/capstone-assessment/) for scoring.

## Completion Requirements

A learner completes the course when they can:

- Explain Archon as a harness for repeatable AI coding workflows.
- Install and verify Archon locally.
- Run a safe workflow in a disposable repository.
- Inspect status, worktrees, logs, artifacts, and changed files.
- Create and validate one command and one workflow.
- Explain a Plan-Implement-Validate flow.
- Route providers only after a single-provider baseline works.
- Assign Claude, Codex, Gemini, Qwen, Kimi, or local models by workflow
  responsibility when using multi-model projects.
- Prepare or create a supervised PR and stop before merge.
- Define local, GitHub, Docker, VPS, or server runtime boundaries before team
  operation.
- Troubleshoot common failures without exposing secrets.
- Name a rollback path for generated changes.

## Completion Outcomes

Use these completion levels:

| Outcome | Meaning |
| --- | --- |
| Complete with supervision | Learner can use Archon on a low-risk real repository with a reviewer. |
| Complete and peer-ready | Learner can help others inspect evidence and review runs. |
| Remediation needed | Learner should repeat one or more units before real-repository work. |

## Course Policy

The course default is supervised operation. Do not graduate learners by removing
approval gates. Graduate them by proving they know which gates still matter and
why.
