---
title: Slide Outline
description: A presentation outline for teaching the Archon curriculum.
category: learning
audience: [operator]
status: current
sidebar:
  order: 19
---

Use this outline to create slides for a live workshop or onboarding session.
Keep slides light; learners should spend most of the time in the terminal, Web
UI, artifacts, logs, and workbook.

## Deck 1: Orientation And Safety

Slide 1: Title

- Archon as a supervised AI coding workflow harness.
- Goal: repeatable, inspectable AI-assisted development.

Slide 2: The Problem

- One long chat is hard to audit.
- Hidden context is fragile.
- Model summaries are not validation.

Slide 3: The Harness Model

- Workflow.
- Worktree.
- Artifact.
- Validation.
- Approval gate.

Slide 4: First Week Boundary

- Sandbox first.
- Secrets stay private.
- Human approval before risky steps.
- Stop before autonomous merge or deployment.

Slide 5: Evidence Habit

- What ran?
- Where did it run?
- What changed?
- What evidence confirms it?

## Deck 2: Setup And First Run

Slide 1: Setup Goal

- CLI works.
- Web UI works or CLI fallback is documented.
- Provider configured privately.
- Sandbox has an initial commit.

Slide 2: Sandbox Repository

- Tiny source file.
- Tiny validation command.
- No secrets.
- Easy reset.

Slide 3: First Workflow

- Start read-only.
- Use the intended repository.
- Record the run.

Slide 4: Inspect Evidence

- Status.
- Logs.
- Artifacts.
- Git status.
- Changed files.

## Deck 3: Authoring

Slide 1: Commands

- Markdown prompt templates.
- Reusable narrow tasks.
- No secrets.

Slide 2: Workflows

- YAML process.
- Nodes and dependencies.
- Explicit handoffs.

Slide 3: Good First Workflow

- One current task.
- One clear input.
- One artifact.
- One deterministic validation.

Slide 4: Common Authoring Mistakes

- Too broad.
- Hidden chat-memory handoffs.
- No validation.
- Provider routing too early.

## Deck 4: Plan-Implement-Validate

Slide 1: Flow

- Plan.
- Approve.
- Implement.
- Validate.
- Decide.

Slide 2: Approval Gate

- Approve from evidence.
- Reject vague plans.
- Revise with concrete instructions.
- Defer when evidence is missing.

Slide 3: Validation

- Tests.
- Lint.
- Type checks.
- File inspection.
- PR review.

Slide 4: Human Decision

- Approve.
- Reject.
- Revise.
- Defer.
- Stop.

## Deck 5: Providers And GitHub

Slide 1: Provider Routing Rule

- Baseline first.
- Route by node responsibility.
- Verify provider setup privately.
- Keep artifacts explicit.

Slide 2: GitHub Boundary

- Issue-to-PR is supervised.
- PR creation is not merge readiness.
- Review before merge.

Slide 3: Adapter Boundary

- Local CLI and Web UI differ from remote adapters.
- Exposure changes risk.
- Authorization and secrets matter.

## Deck 6: Capstone And Graduation

Slide 1: Capstone Goal

- Operate safely from request to evidence-backed decision.

Slide 2: Required Evidence

- Run report.
- Artifacts.
- Logs.
- Validation.
- Human decision.
- Checklist update.

Slide 3: Scoring

- Safety boundary.
- Workflow execution.
- Evidence inspection.
- Validation.
- Approval.
- GitHub readiness.

Slide 4: Graduation

- Do not graduate by removing safety gates.
- Graduate by knowing which gates still matter and why.

## Speaker Notes Pattern

For each slide, prepare:

```text
Point:
Demo:
Question:
Evidence to inspect:
Safety reminder:
```

## Slide Design Notes

- Use diagrams for workflow flow, not dense text.
- Use screenshots only if they contain no secrets.
- Avoid provider comparison scoreboards.
- Prefer one concrete example per concept.
- Keep command blocks short enough to type.
