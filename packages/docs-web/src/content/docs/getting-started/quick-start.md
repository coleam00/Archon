---
title: Quick Start
description: Run your first Archon workflow in minutes.
category: getting-started
audience: [user]
sidebar:
  order: 2
---

## Prerequisites

1. [Install Archon](/getting-started/installation/)
2. [Install Claude Code](/getting-started/ai-assistants/#claude-code) — Archon orchestrates it but does not bundle it
3. Authenticate with Claude: run `claude /login` (uses your existing Claude Pro/Max subscription)
4. In compiled Archon binaries, set `CLAUDE_BIN_PATH` (see [Binary path configuration](/getting-started/ai-assistants/#binary-path-configuration-compiled-binaries-only))
5. Navigate to any git repository
6. For private repos: set `GH_TOKEN` (GitHub), `GITLAB_TOKEN` (GitLab), or `GITEA_TOKEN` (Gitea/Forgejo) — Archon uses these to authenticate when cloning

## Run Your First Workflow

```bash
# List available workflows
archon workflow list

# Ask Archon to assist with your codebase
archon workflow run assist "What does this codebase do?"

# Run a code review
archon workflow run smart-pr-review
```

## The input is the contract

That quoted message is not a prompt — it is the specification the whole run is measured
against, and it is yours to write. Archon governs *how* the work happens: isolation, gates,
retries, the audit trail. It cannot supply *what* you actually wanted. A vague brief does not
produce a vague result; it produces a confident, well-structured answer to a question you did
not ask, and you pay full price for it.

The same applies wherever the run reads its input — a GitHub issue body, a message, a
document. Whichever it is, make it say:

| | |
|---|---|
| **Problem to solve** | What is wrong today, concretely. |
| **Why it is worth solving** | The cost of leaving it alone. |
| **Why now** | What makes this the moment. |
| **Desired outcome** | What is observably different afterwards. |
| **Invariants** | What must stay true across any acceptable implementation. |
| **Acceptance** | How you will know it is done. |

**Solution steering is optional — but silence is a choice too.** Leave it out and the run
picks its own approach, which is often the right call: it has read the code and you may not
have. If you *do* have an opinion about how — reuse this helper, do not add a dependency,
follow the pattern in that module, this must be a migration rather than a rewrite — then say
so in the input. An unstated preference is one the run cannot honour, and you will only find
out when you read the diff.

Put steering last, after the problem is stated. Leading with an implementation narrows the run
to your first guess and hides better answers; adding it at the end constrains *how* without
replacing *what*.

A brief worth running looks like this:

```bash
archon workflow run archon-ship --branch fix/upload-timeout "$(cat <<'BRIEF'
Problem: uploads over ~8 MB fail with a 504 after 30s. The proxy read timeout is
30s and the upload handler streams to disk before responding, so any file large
enough to take longer than that is rejected after the bytes were already sent.

Why it matters: this is the top support complaint this month, and every failure
wastes the user's full upload time before telling them.

Why now: the new export feature ships next week and its files are 20-50 MB, so
this moves from an edge case to the default path.

Outcome: a 50 MB upload completes, and a genuinely stuck upload still fails
rather than hanging forever.

Invariants: no change to the storage layout or the public upload API; memory use
must not scale with file size.

Acceptance: a 50 MB upload succeeds end to end; a test covers the timeout path;
the 30s proxy timeout is either raised deliberately or no longer on the path.

Steering (optional): prefer streaming straight to storage over raising the
timeout, if that holds the memory invariant. Do not add a queue for this.
BRIEF
)" --detach
```

Compare that with `"fix the upload bug"`. Both start a run. Only one can be checked.

Being wrong in the brief is fine and normal — being *silent* is what costs. State the
assumption you are unsure about, and the run has something to contradict.

## What's Next?

For the full getting started guide -- installation, authentication, Web UI setup, CLI setup, and troubleshooting -- see the [Overview](/getting-started/overview/).

- [Overview](/getting-started/overview/) — Complete onboarding guide
- [Core Concepts](/getting-started/concepts/) — Understand workflows, nodes, commands, and isolation
- [Configuration](/getting-started/configuration/) — Customize Archon for your project
- [Authoring Workflows](/guides/authoring-workflows/) — Create your own workflows
- [GitHub Repository](https://github.com/coleam00/Archon) — Source code, issues, and discussions
