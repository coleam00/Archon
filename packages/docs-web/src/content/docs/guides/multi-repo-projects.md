---
title: Multi-Repo Projects
description: Register a multi-repo root as a folder project and drive workflows and chat across every contained service repo.
category: guides
area: workflows
audience: [user]
status: current
sidebar:
  order: 11
---

Many platforms are not a single repository — they're a **root directory holding N service repos** (`auth-service/`, `billing-service/`, …), often with no git at the root itself. Archon models this as a [folder project](/getting-started/concepts/#folder-projects-non-git-workspaces): register the root once, and every workflow and chat runs **in place** at that root, so the agent sees all contained repos at once.

## Register the root

From the multi-repo root, run any workflow with `--folder`. The first run registers the folder project; later runs from anywhere under the root need no flag.

```bash
cd ~/platform          # contains auth-service/, billing-service/, ... — NOT itself a git repo
archon workflow run assist --folder "List every service and its current branch"
# → Registered folder project "platform" (~/platform)
# → Folder project — running in place (no worktree isolation).
```

You can also register from chat (`/register-project platform ~/platform` — a non-git path is auto-detected as a folder) or the web console's **Add Project** (paste the path).

## How work happens across repos

- **The agent's working directory is the root**, so it can `cd` into any child repo, read across services, and make coordinated changes in one run.
- **Per-service git is the agent's job.** Archon does not create a worktree or manage branches/PRs for a folder project — the agent runs `git`/`gh` itself inside each service repo (branch, commit, push, open PR). Your workflow prompts should instruct it to do so per service.
- The chat `/status` command and `archon doctor` list the contained repos so you can confirm what's in scope:

  ```text
  Contains 20 git repos: auth-service, billing-service, … (+10 more)
  ```

- Artifacts and logs are stored under `~/.archon/workspaces/_folder/<slug>/`, and per-project [env vars](/getting-started/configuration/) work exactly as for repo projects.

## When you want isolation for one service

Folder projects intentionally run in the live checkout — `--branch` and `--from` are rejected, and `/worktree` reports "not applicable". If you want Archon-managed **worktree isolation** for a single service (an isolated branch per run, auto PR flow), register that service repo as its **own** project:

```bash
cd ~/platform/auth-service       # a real git repo
archon workflow run implement --branch fix-auth "Fix the token refresh bug"
# → normal repo project: isolated worktree + branch, no --folder
```

The two models compose: keep the root registered as a folder project for cross-service work, and register individual services as repo projects when you want per-run isolation for just that service.

## Not a fit for

- **Archon-managed branching/PRs spanning child repos** — the agent coordinates git across services itself; Archon does not create a composed multi-repo worktree (a future isolation backend may).
- **A repo you want isolated per run** — register *that repo* directly (repo project), not the parent folder.

See [Core Concepts → Folder Projects](/getting-started/concepts/#folder-projects-non-git-workspaces) for the underlying model.
