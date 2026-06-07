---
title: Version Review
description: How to review the Archon curriculum when versions, workflows, providers, or CLI behavior change.
category: learning
audience: [developer, operator]
status: current
sidebar:
  order: 23
---

Use this page when Archon releases or source changes may affect the curriculum.

## Review Trigger

Start a version review when:

- `package.json` version changes.
- `CHANGELOG.md` adds workflow, CLI, provider, adapter, or deployment notes.
- Default workflow files change.
- CLI command files change.
- Provider configuration changes.
- Docs pages under getting started, guides, reference, adapters, or deployment
  change.

## Version Review Record

```text
Review date:
Reviewer:
Archon version:
Commit:
Reason for review:
Docs build result:
Curriculum pages changed:
Follow-up needed:
```

## Workflow Catalog Review

Check:

```bash
archon workflow list
```

Record:

```text
Workflow count:
New workflows:
Removed workflows:
Renamed workflows:
Beginner recommendations changed:
Advanced/specialized list changed:
Tutorial update needed:
```

## CLI Review

Check current CLI help and source.

Record:

```text
Commands added:
Commands removed:
Flags added:
Flags removed:
Examples affected:
Unsupported-command notes affected:
```

Pay special attention to setup, workflow, isolation, serve, validate, and GitHub
examples.

## Provider Review

Record:

```text
Provider names changed:
Config fields changed:
Model examples changed:
Binary/source behavior changed:
Authentication guidance changed:
Provider fallback changed:
```

Never preserve a model ID in the curriculum unless it is verified or clearly
presented as something learners must verify locally.

## Safety Review

Record:

```text
Approval behavior changed:
Worktree behavior changed:
Artifact/log behavior changed:
Secret-handling guidance changed:
GitHub merge boundary changed:
Adapter exposure changed:
```

If safety behavior changes, update:

- Practical tutorial.
- Curriculum guide.
- Capstone assessment.
- Facilitator evaluation.
- FAQ.

## Docs Route Review

Run the docs build and confirm Learning routes still render.

```bash
bun --filter @archon/docs-web build
```

Record:

```text
Build passed:
Generated learning pages:
Broken links found:
Schema/frontmatter changes needed:
```

## Change Classification

Classify the update:

| Type | Meaning | Action |
| --- | --- | --- |
| Patch | Wording, small examples, links | Update affected pages and build. |
| Minor | New workflow, command, provider option, or lab impact | Update tutorial, curriculum, labs, and assessment as needed. |
| Major | Safety model, setup path, provider model, or GitHub flow changes | Re-review the full curriculum path before teaching. |

## Review Completion

Version review is complete when:

- Source-backed claims are rechecked.
- Affected examples are updated.
- Safety guidance remains explicit.
- Learning routes build.
- Known limitations are recorded.
