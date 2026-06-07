---
title: Learner FAQ
description: Frequently asked questions for learners and facilitators using the Archon curriculum.
category: learning
audience: [user, operator]
status: current
sidebar:
  order: 20
---

Use this FAQ during self-study or workshops. It gives consistent answers to
common learner questions.

## Can I Use A Real Repository For The First Exercise?

No. Use a disposable sandbox first. Real repositories come after you can inspect
run status, worktrees, artifacts, logs, changed files, validation output, and
approval decisions.

## Why So Much Focus On Evidence?

Because assistant summaries are useful but not enough. Evidence lets you verify
what actually happened: which repository was used, which files changed, what
validation ran, and what decision is justified.

## When Can I Use `--no-worktree`?

Use `--no-worktree` for read-only tasks while learning. If a workflow might edit
files, use an isolated branch or worktree.

## What Counts As A Secret?

API keys, OAuth tokens, GitHub tokens, provider auth files, credentials, and full
environment file contents. Do not paste them into chat, shared notes, artifacts,
logs, command files, or workflow files.

## What If Setup Fails?

Do not burn the whole session on setup. Record the blocker, assign a next
action, and continue with a fallback: workbook prompts, evidence review, sample
artifacts, command design, or pairing with another learner.

## Why Start With One Provider?

Because provider routing adds complexity. First prove the workflow works with
one provider. Then route one node only if its responsibility justifies a
different provider.

## How Do I Know A Plan Is Good Enough To Approve?

A beginner-friendly plan should name:

- Files it will inspect or change.
- Validation commands.
- Risks.
- Rollback path.
- Expected artifacts or output.

If those are missing, reject or revise the plan.

## Is Passing Validation Enough To Merge?

No. Passing validation is one piece of evidence. Merge readiness also requires
diff inspection, PR review, secret checks, residual risk assessment, and a human
merge decision.

## What If The Assistant Says Something That Conflicts With The Docs?

Trust source-backed docs and local validation over assistant claims. Record the
conflict and inspect the relevant command, workflow, logs, or source file.

## Can I Skip The Capstone?

Not if you want to use Archon on a real project. The capstone proves you can
operate safely from request to evidence-backed decision.

## What Is The Fastest Safe Path?

Use the syllabus, create the sandbox, run a read-only workflow, inspect evidence,
author one narrow command or workflow, run Plan-Implement-Validate, and complete
a small capstone. Fast is fine; skipping evidence is not.

## What Should I Do After Completing The Curriculum?

Pick one low-risk real repository, choose one workflow, define approval gates,
run deterministic validation, and keep supervision until your team agrees the
operating checklist is reliable.
