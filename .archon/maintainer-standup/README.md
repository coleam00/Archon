# Maintainer Standup

Daily morning briefing for Archon maintainers. Pulls latest `dev`, fetches all open PRs and assigned issues, classifies them **P1–P4** against `direction.md`, and surfaces progress versus the previous run (merged, closed, what you shipped).

## Files in this folder

| File | Committed? | Purpose |
|------|:---:|---------|
| `direction.md` | ✓ | Project north-star — what Archon IS / IS NOT. **Shared by all maintainers.** Drives PR triage and polite-decline classification. |
| `README.md` | ✓ | This file. |
| `profile.md.example` | ✓ | Template for new maintainers to copy. |
| `profile.md` | gitignored | Your personal config (gh handle, role, focus areas). |
| `state.json` | gitignored | Auto-written carry-over for the next run. |
| `briefs/YYYY-MM-DD.md` | gitignored | Daily prose briefs. Last 3 are read into the next run. |

`direction.md` is committed because triage decisions should be consistent across maintainers and across runs. `profile.md`, `state.json`, and `briefs/` are personal — your focus, your daily notes, your reading material — so each maintainer manages their own.

## Setup for a new maintainer

1. Copy the template:
   ```bash
   cp .archon/maintainer-standup/profile.md.example .archon/maintainer-standup/profile.md
   ```
2. Edit `profile.md`:
   - Set `gh_handle` to your GitHub login.
   - Set `role` and `scope` to match your maintainer focus (`main_maintainer` / `everything` for full coverage; narrower for sub-maintainers).
   - Optionally fill in **Currently focused on** — the synthesizer weights items toward what you list there.
3. Run it:
   ```bash
   archon workflow run maintainer-standup ""
   ```
4. The first run is a baseline (no prior state to diff). Subsequent runs compare against `state.json` and surface "Resolved since last run" / "What you shipped" / aged carry-over items.

## How it works (engine view)

1. **Three gather scripts** run in parallel (`bun`, no AI):
   - `maintainer-standup-git-status.ts` — fetches `origin/dev`, fast-forwards if safe, captures new commits + diff stat since the last recorded SHA.
   - `maintainer-standup-gh-data.ts` — pulls open PRs (full metadata), review-requested PRs, authored-by-me PRs, assigned issues, recently-filed unlabeled issues, and recently-closed PRs/issues since the last run.
   - `maintainer-standup-read-context.ts` — reads `direction.md`, `profile.md`, `state.json`, and the last 3 briefs.
2. **Synthesis node** (`command: maintainer-standup`, Claude Sonnet, structured output) reads everything, optionally drills into specific PRs/issues with `gh pr view` / `gh issue view`, classifies P1–P4 against `direction.md`, and returns `{ brief_markdown, next_state }`.
3. **Persist node** writes `brief_markdown` to `briefs/YYYY-MM-DD.md` and `next_state` to `state.json`.

The workflow runs **in the live checkout** (`worktree.enabled: false`) — it has to read this folder and pull `dev`. `--branch` and `--no-worktree` flags are rejected.

## Editing direction.md

`direction.md` is the source of truth for "what Archon is / isn't" during PR triage. Add a clause when a triage decision needs justification (so the next maintainer can reach the same conclusion). When declining a PR, cite the clause inline (e.g., `direction.md §single-developer-tool`).

The synthesizer also surfaces **Direction questions raised** — PRs that touch areas where `direction.md` has no stance yet. Use those to evolve the doc deliberately rather than deciding case-by-case.

## Customizing the brief format

The output structure is defined in `.archon/commands/maintainer-standup.md`. Adjust the Phase 3 template if you want different sections or a different P-tier scheme. The synthesizer's `output_format` schema lives in `.archon/workflows/maintainer-standup.yaml`.
