---
title: Quickstart
description: Install the Archon binary, add a provider and run your first workflow.
category: getting-started
audience: [user]
sidebar:
  order: 2
---

This page takes you from nothing to a finished run in any git repository.

## 1. Install an agent

Archon runs agents you install yourself. Install at least one and sign in:

- **Claude Code:** `curl -fsSL https://claude.ai/install.sh | bash` on macOS, Linux or WSL, or `irm https://claude.ai/install.ps1 | iex` in Windows PowerShell. Then run `claude` and sign in with your Claude subscription.
- **Codex:** install the Codex CLI and run `codex login`.

Archon finds Claude Code at the native installer's path (`~/.local/bin/claude`) on its own. Only an npm or other custom install needs a path; see [Claude Code binary path](/getting-started/ai-assistants/#binary-path-configuration-compiled-binaries-only).

## 2. Install Archon

```bash
curl -fsSL https://archon.diy/install | bash        # macOS / Linux
irm https://archon.diy/install.ps1 | iex             # Windows (PowerShell)
```

The installer asks which providers to add (`claude`, `codex`, `pi`) and runs `archon provider add` for them. With Homebrew, install and then add providers yourself:

```bash
brew install coleam00/archon/archon
archon setup        # or: archon provider add claude
```

Check the install:

```bash
archon version
archon doctor       # lists installed providers and their diagnostics
```

Docker, source installs and older x64 CPUs without AVX2 are covered in [Installation](/getting-started/installation/).

## 3. Run a workflow

In any git repository:

```bash
cd your-project
archon workflow list
archon workflow run archon-investigate "Why does the login test fail?"
```

`archon-investigate` traces the question through your code until it can prove the answer, and leaves the repository as it found it. The run streams to your terminal and ends with its report.

## 4. Read the result

```bash
archon workflow runs              # recent runs in this project, with their IDs
archon workflow get <run-id>      # one run: status, nodes and outcome
archon workflow attention         # runs paused for your decision
```

A run that needs a decision pauses as an attention item. Answer it with `archon workflow respond <run-id> <decision> "<reason>"`. See [Operate runs](/getting-started/operate/).

To browse runs in a browser instead, start the Web UI with `archon serve`.

## The input is the contract

The message you pass to a run is the specification it is measured against. Archon governs how the work happens: isolation, gates, retries and the audit trail. It cannot supply what you wanted. A vague brief produces a confident answer to a question you didn't ask.

Wherever the run reads its input, an issue body, a message or a document, make it state:

| | |
|---|---|
| **Problem** | What is wrong today, concretely |
| **Why it is worth solving** | The cost of leaving it alone |
| **Why now** | What makes this the moment |
| **Desired outcome** | What is observably different afterwards |
| **Invariants** | What must stay true in any acceptable implementation |
| **Acceptance** | How you will know it is done |

Solution steering is optional and goes last. Leave it out and the run chooses its own approach. If you hold a constraint, such as "reuse this helper" or "no new dependency", say it, because the run can't honor a preference you didn't state.

A brief worth running:

```bash
archon workflow run archon-ship --branch fix/upload-timeout "$(cat <<'BRIEF'
Problem: uploads over ~8 MB fail with a 504 after 30s. The proxy read timeout is
30s and the upload handler streams to disk before responding.

Why it matters: this is the top support complaint this month.

Why now: the export feature ships next week and its files are 20-50 MB.

Outcome: a 50 MB upload completes, and a stuck upload still fails instead of hanging.

Invariants: no change to the storage layout or the public upload API; memory use
must not scale with file size.

Acceptance: a 50 MB upload succeeds end to end; a test covers the timeout path.

Steering: prefer streaming straight to storage over raising the timeout.
BRIEF
)" --detach
```

`archon-ship` takes an issue or request to a reviewed pull request. It works through the GitHub CLI, so run `gh auth login` first. `--detach` starts the run in the background and returns at once.

## Next steps

- [Build your first workflow](/getting-started/first-workflow/)
- [Set up the SDLC factory](/getting-started/sdlc-factory/): the bundled software factory, from issue to merge
- [Configuration](/getting-started/configuration/): project settings and environment variables
