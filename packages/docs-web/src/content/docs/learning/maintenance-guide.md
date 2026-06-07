---
title: Curriculum Maintenance Guide
description: How to keep the Archon curriculum aligned with current source, docs, workflows, and safety policy.
category: learning
audience: [developer, operator]
status: current
sidebar:
  order: 21
---

Use this guide when updating the curriculum after Archon changes. The goal is to
keep learning material source-backed, current, and safe.

## Maintenance Principle

Do not update the curriculum from memory. Verify claims against the repository,
current docs, and local commands. Transcript material can inspire examples, but
official source and local validation decide what the curriculum teaches.

## When To Review

Review the curriculum when:

- CLI commands change.
- Workflow names or defaults change.
- Provider setup changes.
- Web UI routes or behavior change.
- Adapter setup changes.
- Security or secret-handling guidance changes.
- Release notes mention workflows, providers, isolation, approvals, or GitHub.
- A cohort reports a repeated blocker.

## Source Inventory

Check these first:

```text
README.md
CONTRIBUTING.md
CHANGELOG.md
packages/docs-web/src/content/docs/
packages/cli/src/
packages/workflows/src/defaults/
packages/providers/src/
packages/server/src/routes/
packages/adapters/src/
```

For learning-specific structure, also check:

```text
packages/docs-web/src/content/docs/learning/
docs/learning/
TUTORIAL.md
```

## Review Checklist

```text
CLI command examples still work:
Default workflow names still match:
Provider names and setup still match:
Model examples are still valid or clearly marked:
GitHub flow still stops before merge:
Approval gate behavior still matches docs:
Worktree/isolation guidance still matches source:
Artifact/log paths still match source:
Secret-handling guidance still matches security docs:
Docs build passes:
```

## Claims That Need Fresh Verification

Always verify these before publishing:

- Current default branch.
- Default workflow catalog.
- Supported CLI subcommands.
- Provider configuration fields.
- Binary versus source setup behavior.
- GitHub adapter requirements.
- Web UI URLs and health endpoints.
- Any model identifier.
- Any statement about unavailable commands.

## Updating Examples

When an example changes:

1. Update the practical tutorial first.
2. Update the curriculum guide if pacing or assessment changes.
3. Update exercise pages if the example is used in labs.
4. Update sample artifacts if expected evidence changes.
5. Update the reading map if new pages are added.
6. Run the docs build.

## Handling Uncertainty

If a claim cannot be verified:

- Remove it, or
- Mark it explicitly as a maintenance note, or
- Point learners to the live command that discovers the answer.

Prefer:

```text
Run archon workflow list for the current workflow catalog.
```

Avoid:

```text
Archon always ships exactly N workflows.
```

## Safety Regression Review

Before publishing, inspect whether any new text encourages:

- Real repositories before sandbox practice.
- Secrets in chat or shared notes.
- Modifying work without isolation.
- Provider routing before a baseline.
- Approval gates removed for convenience.
- Autonomous merge while learning.
- Trusting assistant summaries without evidence.

If it does, rewrite the section.

## Cohort Feedback Loop

After each cohort, record:

```text
Repeated setup blocker:
Most confusing term:
Exercise that took too long:
Exercise that was too easy:
Safety rule that needed repetition:
Docs page that learners opened most:
Docs page that was missing:
Recommended curriculum update:
```

Turn repeated blockers into:

- FAQ entries.
- Troubleshooting labs.
- Instructor notes.
- Setup guide changes.

Use [Cohort Report](/learning/cohort-report/) and
[Curriculum Metrics](/learning/curriculum-metrics/) to decide which updates are
worth making.

## Build Verification

Run:

```bash
bun --filter @archon/docs-web build
```

Expected:

```text
Build completes and generates the learning routes.
```

If the build fails, fix schema, frontmatter, route, or Markdown issues before
publishing.
