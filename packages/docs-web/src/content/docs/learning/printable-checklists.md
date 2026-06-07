---
title: Printable Checklist Pack
description: Compact Archon curriculum checklists for learners, facilitators, reviewers, and maintainers.
category: learning
audience: [user, operator, developer]
status: current
sidebar:
  order: 35
---

Use these compact checklists during live sessions, office hours, capstones, and
publishing reviews.

## Learner Run Checklist

```text
Before running:
[ ] I am in the intended repository.
[ ] The repository is disposable or low-risk enough.
[ ] Secrets are not in chat, notes, commands, or workflow files.
[ ] Modifying work uses a branch or worktree.
[ ] I know what validation should run.

After running:
[ ] I inspected run status.
[ ] I inspected logs.
[ ] I inspected artifacts.
[ ] I inspected changed files.
[ ] I inspected validation output.
[ ] I wrote a human decision.
```

## Approval Gate Checklist

```text
Before approving:
[ ] Plan names files.
[ ] Plan names validation commands.
[ ] Plan names risks.
[ ] Plan names rollback.
[ ] Plan matches the request.
[ ] Human reviewer understands what may change.

Decision:
[ ] approve
[ ] reject
[ ] revise
[ ] defer
```

## Facilitator Session Checklist

```text
Before session:
[ ] Goal is clear.
[ ] Safety rule is selected.
[ ] Sandbox is ready.
[ ] Provider fallback is ready.
[ ] Exercise is selected.
[ ] No shared material contains secrets.

During session:
[ ] Demo is short.
[ ] Learners drive hands-on work.
[ ] Evidence is inspected.
[ ] Blockers are recorded.
[ ] Checklist update is captured.
```

## Capstone Checklist

```text
[ ] Objective stated.
[ ] Risk boundary stated.
[ ] Workflow or command selected.
[ ] Branch or worktree identified.
[ ] Artifacts inspected.
[ ] Logs inspected.
[ ] Validation recorded.
[ ] Human decision recorded.
[ ] No autonomous merge.
[ ] Operating checklist updated.
```

## First Real Repository Checklist

```text
[ ] Learner passed capstone.
[ ] Graduation checklist complete.
[ ] Repository is low-risk enough.
[ ] Reviewer assigned.
[ ] Workflow selected.
[ ] Expected files named.
[ ] Validation named.
[ ] Rollback path named.
[ ] Stop conditions named.
```

## Publishing Checklist

```text
[ ] Source-backed claims reviewed.
[ ] CLI examples verified.
[ ] Workflow examples verified.
[ ] Provider examples verified.
[ ] Safety guidance reviewed.
[ ] Learning index links major pages.
[ ] Docs build passes.
[ ] Known limitations recorded.
```

## Maintenance Checklist

```text
[ ] Changelog reviewed.
[ ] CLI changes reviewed.
[ ] Workflow catalog reviewed.
[ ] Provider docs reviewed.
[ ] GitHub/adapters reviewed.
[ ] Safety model reviewed.
[ ] Curriculum updates made.
[ ] Docs build passes.
```
