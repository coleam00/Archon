---
title: Curriculum Glossary
description: Plain-language definitions for Archon curriculum terms.
category: learning
audience: [user, operator]
status: current
sidebar:
  order: 17
---

Use this glossary when teaching or reviewing the curriculum. The definitions are
plain-language teaching definitions, not exhaustive technical reference entries.

## Agentic Workflow

A workflow step or sequence where an AI coding assistant reasons, reads files,
writes code, reviews output, or summarizes findings.

## Approval Gate

A workflow pause where a human decides whether to approve, reject, revise, or
defer the next step. Approval should depend on evidence.

## Artifact

A file written by a workflow step so later steps or humans can inspect it. Good
artifacts reduce dependence on hidden chat memory.

## Assistant

The coding-agent client Archon asks to do work, such as Claude Code, Codex, or
Pi.

## Baseline

The simplest working version of a workflow. In the curriculum, provider routing
starts only after a single-provider baseline works.

## Capstone

The final exercise where a learner proves they can operate Archon safely from
request to evidence-backed decision.

## Command

A Markdown prompt template stored in `.archon/commands/`. Commands are reusable
building blocks for repeated assistant tasks.

## Deterministic Validation

A check whose result does not depend on the assistant's opinion, such as a test
command, lint command, type check, or explicit file inspection.

## Evidence

Anything inspected outside the assistant's final summary: Git status, diffs,
logs, artifacts, validation output, branches, worktrees, or PR content.

## Harness

The process around an assistant: workflow steps, isolation, artifacts,
validation, logs, and human approval gates.

## Human Decision

The learner's explicit choice after inspecting evidence. Common decisions are
approve, reject, revise, defer, or stop.

## Isolation

Keeping generated work away from the main checkout, usually with branches or Git
worktrees.

## Learner Operating Checklist

A personal checklist the learner updates throughout the curriculum. It records
the habits they will use before running, approving, trusting, or merging work.

## Model

The specific model an assistant uses. Provider routing should be based on node
responsibility, not model popularity.

## Node

One step in a workflow. A node might ask an assistant to plan, run a script,
wait for approval, validate output, or summarize evidence.

## Plan-Implement-Validate

A supervised workflow shape: write a plan, inspect and approve it, implement the
change, run deterministic validation, then make a final human decision.

## Provider

The Archon workflow provider used for a node, such as `claude`, `codex`, or
`pi`.

## Provider Routing

Assigning different workflow nodes to different providers. In the curriculum,
learners route providers only after a single-provider baseline works.

## PR Readiness

The state where a branch is ready for human pull-request review. It is not the
same as being ready to merge.

## Remediation

Focused practice assigned when a learner misses a completion signal. Good
remediation repeats the smallest exercise that proves the missing skill.

## Run Report

A short evidence record for a workflow or command run: what ran, where it ran,
what changed, what evidence was inspected, what validation ran, and what human
decision followed.

## Sandbox

A disposable or low-risk repository used for learning. Early curriculum work
should happen in a sandbox before real project work.

## Secret

Any API key, OAuth token, provider auth file, GitHub token, credential, or full
environment file content. Secrets do not belong in chat, shared notes, logs,
artifacts, or diffs.

## Workflow

A YAML file stored in `.archon/workflows/` that defines a repeatable process
made of nodes.

## Worktree

A Git working directory separate from the main checkout. Worktrees help isolate
workflow changes and make rollback easier.
