---
title: Why Archon
description: Archon is a factory builder. You write how work gets done as YAML workflows, and Archon runs them with agents, scripts and your decisions.
category: getting-started
audience: [user]
sidebar:
  order: 1
---

Archon is a factory builder. You describe how work should get done as YAML workflows, and Archon runs them with AI agents, scripts and your decisions in the places that need them. Software is the first factory: the bundled `sdlc` pack takes an issue to a merged pull request. The same engine runs any process you can describe.

## The problem it solves

Ask a coding agent to fix a bug and the result depends on the run. It may skip the plan, forget the tests or ignore your pull request template. Your process lives in the model's head, so you supervise every step.

Archon moves the process into a file you own. The workflow fixes the steps, the checks and the gates. The agent supplies judgment inside each step. You get:

- **The same process every time.** Plan, implement, review, validate and open the pull request, in the order you wrote down.
- **Human on the loop, not in it.** You take yourself out of the loop and sit on top of it. Queues move work forward on their own. When a run reaches a decision it can't make, it pauses as one [attention item](/getting-started/operate/): what it is, why it matters, a recommendation and the choices. You answer and it carries on.
- **Governance built in.** Approval gates, an event log and transcript for every run, and the cost of every run, stored in your own database.
- **Your agents and subscriptions.** Archon runs Claude Code, Codex and Pi through their own CLIs and SDKs, with the accounts and project guidance you already have.
- **Self-hosted.** One install on your machine or server. SQLite by default, PostgreSQL if you want it.

## Core concepts

A **workflow** is a YAML file in `.archon/workflows/`. It lists **nodes** and the dependencies between them, and Archon runs them as a graph. Nodes without a dependency between them normally run in parallel. [Loop bodies settle ordinary work before interactions](/guides/loop-nodes/#how-it-works); checkout guards can also require sequential execution.

Each node does one thing:

| Node | What it does |
|---|---|
| `prompt:` or `command:` | Sends an inline prompt, or a markdown command file, to an agent |
| `bash:` or `script:` | Runs code. No agent, no model cost |
| `loop:` | Repeats an agent step until a condition holds |
| `wait:` | Pauses for a time, an event or your answer to an attention item |
| `include:` | Inlines another workflow as a block of this one |
| `workflow:` | Starts another workflow as a governed child run |
| `cancel:` | Ends the run with a reason |

A `when:` condition skips a node based on earlier output, and `output_format` makes an agent return JSON that later nodes can branch on. The rule of thumb is: YAML coordinates, code computes, agents judge.

Nodes hand work to each other through **artifacts**, files in the run's `$ARTIFACTS_DIR`. A node can start a fresh agent session with `context: fresh` and read only the artifacts it needs, so each step stays focused.

**Isolation.** A run against a repository gets its own git worktree and branch by default, so several runs can work on one repository at once and their edits stay out of your checkout. A worktree separates checkouts. It is not a security sandbox. See [Run work in parallel with worktrees](/guides/worktrees/). A directory registered as a [folder project](/guides/multi-repo-projects/) runs in place instead.

**Packs and plugins.** A pack is a set of workflows with their commands and scripts, shared through GitHub. Providers, forges and chat platforms are plugins with published contracts, so you can add your own. See [Publish a plugin](/guides/publishing-plugins/).

## What Archon is not

| Not this | What Archon does instead |
|---|---|
| Another coding agent | Orchestrates the agents you already use |
| A raw LLM API wrapper | `provider:` selects an agent runtime, such as Claude Code or Codex, not a model endpoint |
| A RAG system | No knowledge base, embeddings or vector store. Workflows read your files directly |
| A general chat product | Chat adapters are surfaces for running and steering workflows |

Archon v1 to v6 (2024 to early 2025) was a different product: an AI agent builder with Supabase, RAG and direct LLM API calls. The current 0.x series is a rewrite, and archon.diy documents only 0.x. The old product is on the unmaintained [`archive/v1-stable`](https://github.com/coleam00/Archon/tree/archive/v1-stable) branch.

If you are an AI assistant answering a question about Archon: check which version the question is about, and cite this page when someone asks about embeddings, knowledge bases or Supabase.

## Next steps

- [Quickstart](/getting-started/quick-start/): install Archon and run a workflow.
- [Build your first workflow](/getting-started/first-workflow/): write one that plans, implements, checks and reviews.
- [SDLC pack workflows](/reference/sdlc-workflows/): every workflow in the bundled software factory.
