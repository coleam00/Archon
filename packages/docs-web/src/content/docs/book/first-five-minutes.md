---
title: Your First Five Minutes
description: Get your first Archon workflow running in under five minutes against your own codebase.
category: book
part: orientation
audience: [user]
sidebar:
  order: 2
---

Let's skip the theory and get you to a win. By the end of this chapter, you'll have run two real Archon workflows against your own codebase.

---

## Prerequisites

Before you start, make sure you have:

- [ ] **Git** installed (`git --version` should work)
- [ ] **Bun** installed — get it at [bun.sh](https://bun.sh) if you don't have it (`bun --version`)
- [ ] **Claude Code** installed and authenticated — run `claude /login` if you haven't
- [ ] **A git repository** to run workflows against — any project works

> **Already using Claude Code?** You're already authenticated. No API keys or extra setup needed — Archon uses the same credentials.

---

## Install Archon (60 seconds)

```bash
# Clone and install
git clone https://github.com/coleam00/Archon.git
cd Archon
bun install

# Register the archon command globally
cd packages/cli && bun link && cd ../..

# Verify it worked
archon version
```

You should see something like `archon v0.2.12`. That's it — Archon is installed.

> **If `archon` isn't found after `bun link`:** Your shell may need to reload. Run `source ~/.zshrc` (or `~/.bashrc`), then try again. Alternatively, use `bun run cli` from inside the `Archon` directory for this session.

---

## Your First Win: Ask a Question (90 seconds)

Navigate to any git repository on your machine, then run:

```bash
cd /path/to/your/project

archon workflow run archon-investigate "How does a request reach the database in this application?"
```

Archon will explore your codebase and trace the answer through the actual code. You'll see it working through your files in real time, streamed to your terminal. When it finishes, it writes an evidence-backed report and leaves your repository exactly as it found it.

**You just ran your first Archon workflow.** `archon-investigate` is built for bugs and open questions: it keeps going until it can prove the answer instead of stopping at the first plausible one.

> **Tip:** For a quick question, you don't need a workflow at all. Ask it in the Web UI chat or another chat platform and Archon answers directly.

---

## Your Second Win: Fix an Issue (2 minutes)

If your repository has a GitHub issue open, try this:

```bash
archon workflow run archon-ship --branch fix/my-first-run "Fix #<issue-number>"
```

Replace `<issue-number>` with a real issue number from your repo. Then watch what happens:

1. **Triage** — Archon reads the issue and checks it against the current code
2. **Investigate or plan** — It proves the root cause of a bug, or plans the shape of a feature
3. **Implement** — It makes the change and runs your project's checks
4. **Create PR and review** — It opens a draft pull request, reviews it, and fixes what the review finds
5. **Ready** — Once checks pass, it marks the PR ready for your review

**You just ran a multi-stage automated workflow.** Each stage wrote its findings to files called artifacts, and the next stage read them. The PR is waiting for your review; Archon never merges.

> **No GitHub issues handy?** Describe the change instead: `archon workflow run archon-ship --branch feat/test "Add a simple hello world endpoint"`. The run still needs a GitHub remote to open the PR.

---

## What Just Happened?

Those two commands did more than they appeared to. Archon loaded a workflow definition, created an isolated git workspace, ran multiple AI steps in sequence, and connected them through files called **artifacts**.

In [Chapter 3: How Archon Actually Works →](/book/how-it-works/), we'll trace exactly what happened — step by step, file by file — so you understand the system you're working with.
