---
title: What Is Archon?
description: Archon makes your AI coding assistant predictable by giving it a deterministic process to follow.
category: book
part: orientation
audience: [user]
sidebar:
  order: 1
---

Archon makes your AI coding assistant predictable. Not by limiting it — by giving it a process to follow.

---

## The Problem: Unpredictable AI

You've probably experienced this: you ask an AI coding assistant to fix a bug. Sometimes it investigates first, sometimes it dives straight into editing. Sometimes it runs tests, sometimes it doesn't. Sometimes it creates a branch, sometimes it just modifies your working directory.

The AI is capable. But its behavior changes run to run, and your development process lives inside the model's head — not yours.

This inconsistency has real costs:

- You can't trust the output without reviewing every step
- You can't hand off a task and walk away
- You can't build on the AI's work reliably because the process differs each time

The problem isn't intelligence — it's process. The AI doesn't know *your* process, and even if you tell it, it might not follow it consistently.

---

## The Solution: Deterministic Workflows

Archon separates **what happens** from **how the AI thinks**.

You define the process. A **workflow** specifies the exact sequence of steps: investigate first, then implement, then validate, then create a PR. The AI brings intelligence to each step — reading code, making decisions, writing changes — but the structure is yours.

Think of it like a recipe and a chef. The recipe (workflow) defines the steps, the order, and the success criteria. The chef (AI) applies skill and judgment to execute each step. You get consistent results *and* creative execution.

```
Recipe (Workflow) + Chef (AI) = Consistent Quality
```

Structure is deterministic. Intelligence is not constrained. You get both.

---

## The Three Core Concepts

Everything in Archon builds on three ideas:

| Concept | What It Is | Think of It Like |
|---------|-----------|-----------------|
| **Command** | A markdown file containing instructions for the AI to execute a single task | A function |
| **Workflow** | A YAML file that orchestrates multiple commands into an automated pipeline | A script |
| **Isolation** | The system of using worktrees to run tasks in separate directories | A sandbox |

Here's how they relate:

```
Command (single task)
    ↓
Workflow (sequence of commands)
    ↓
Isolation (each workflow run gets its own workspace)
```

A **command** is the atomic unit. It's a markdown file with instructions: "Investigate this GitHub issue. Read the relevant code. Write your findings to a file." One task, one command.

A **workflow** chains commands together. It's a YAML file that says: "Run investigate-issue, then run fix-issue, then run validate, then run create-pr." The workflow owns the sequence; each command owns its step.

**Isolation** means each workflow run happens in its own git worktree — a separate working directory with its own branch. You can run three workflows in parallel without them stepping on each other.

That's it. Everything else in Archon builds on these three ideas.

---

## What Can You Do With Archon?

Archon ships with workflows for the most common development tasks:

- **Fix a GitHub issue** — Investigate, implement, validate, and open a PR automatically
- **Build a feature from an idea** — Go from a description to a working, reviewed PR
- **Review a pull request** — Multi-perspective code review with structured feedback
- **Answer questions about your codebase** — Ask anything, get contextually-aware answers
- **Resolve merge conflicts** — Analyze and fix conflicts with full context

And when the built-in workflows don't fit your process? You build your own. In [Chapter 4](/book/essential-workflows/), you'll see the full catalog of built-in workflows. In [Chapter 7](/book/first-workflow/), you'll build one yourself.

---

Ready to see it in action? Let's get you to your first win in five minutes. Continue to [Chapter 2: Your First Five Minutes →](/book/first-five-minutes/)
