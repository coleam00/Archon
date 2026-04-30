# PRD-Pipeline Workflows — Design Spec

**Status:** Spec frozen, ready to implement
**Owner:** Steven
**Created:** 2026-04-30
**Reference workflow (existing):** `.archon/workflows/defaults/archon-piv-loop.yaml`

---

## 0. What this is

A four-workflow Archon pipeline that takes a free-form idea all the way to merged PRs, with humans in the loop at every high-leverage decision and Memexia as the durable knowledge store. The pipeline is split into four separate Archon workflows so each phase can be re-run, resumed, or skipped independently.

The pipeline is inspired by — but does not replace — the existing `archon-piv-loop`. PIV assumes a PRD already exists and focuses on planning + implementation for one feature. This pipeline starts upstream of PIV (brainstorm) and goes downstream (multi-issue execution).

## 1. The 8-phase methodology this implements

This is the methodology being mechanised across the four workflows. Treat it as the contract.

1. **Brainstorm** — Free-form human brain dump. AI listens, doesn't structure.
2. **Clarifying questions** — AI surfaces assumptions, edge cases, missing context. Targeted questions only — never generic. Output is the Q&A exchange.
3. **Create PRD** — Structured doc: summary, user stories, features, edge cases, out-of-scope, success criteria. Living document.
4. **Create stories** — AI breaks PRD into individual GitHub issues. AI asks questions about each story before finalising — locks intent before any code is written.
5. **Prime** — Before any ticket: load ticket description + acceptance criteria + recent git history + files-to-touch + parent PRD context.
6. **Plan** — Per-ticket `plan.md` with summary, locked decisions, user story, patterns to follow, files to create/update, task list, self-validation strategy, references.
7. **Implement** — Fresh AI session reads `plan.md`, creates branch, implements task list, type-checks + lints + tests, optionally screenshots, updates ticket, opens PR.
8. **Validate (human)** — Human reviews PR diff, implementation notes, the running app. Only after sign-off does the PR merge.

Critical: phase 7 runs in a **fresh** AI session — not the one that planned. Sessions accumulate context and bias.

## 2. Architecture decisions (locked)

### 2.1 Four workflows, not one

| # | Workflow name | Phases covered | Input | Output |
|---|---|---|---|---|
| 1 | `archon-brainstorm-to-prd` | 1, 2, 3 | free text or `--from-existing <path>` | `docs/prd-<slug>.md`, Memexia bank |
| 2 | `archon-prd-to-plan` | 6 (overall plan) | PRD path | `docs/plans/<slug>.md` |
| 3 | `archon-plan-to-stories` | 4 | plan path | `docs/stories/<slug>-<n>.md`, GitHub issues |
| 4 | `archon-execute-story` | 5, 6 (per-story refine), 7, 8 | issue number | branch + PR |

Each is its own Archon workflow YAML in `.archon/workflows/`. They use the Archon CLI's default worktree isolation. Workflows 1–3 commit + push their artifacts so Workflow 4 can read them.

### 2.2 Knowledge storage split

- **Structured artifacts** (PRD, overall plan, per-story plans) → markdown files in the repo at stable paths. Diffable, deterministic, fast for the implement agent to read with `Read`.
- **Loose / queryable knowledge** (research findings, decisions, gotchas, codebase observations) → Memexia bank, scoped per-project/sprint.

Future work (logged, not blocking): direct doc upload to Memexia. For now, structured docs stay in the repo.

### 2.3 Memexia integration

- **One bank per pipeline initiative.** Name = `<project-name>-<workflow-1-run-id>` (e.g. `OpenSkills-f404737dff6e38e48cdc956b260f1f78`). Project name comes from the git remote URL (or repo basename as fallback); run ID is the Archon-assigned UUID for the brainstorm run that created the bank. Uniqueness is guaranteed by the run ID; no collision check needed.
- Banks are **not cleaned up**. Old initiative banks remain searchable as AI context for future runs (a brainstorm can recall lessons from prior similar initiatives via Memexia search).
- Bank declared **once** in PRD frontmatter. Every downstream artifact and issue references the bank by name.
- PRD frontmatter shape:
  ```markdown
  ---
  title: <feature title>
  slug: <feature-slug>
  memexia_bank: <bank-name>
  prd_path: docs/prd-<slug>.md
  created_at: 2026-04-30
  ---
  ```
- Every Claude node that touches Memexia preloads `skills: [memexia-memory]` so memories land in the right zones consistently.
- Every such node attaches the Memexia MCP via the `mcp:` field, pointing to a new `.archon/mcp/memexia.json` config file.

### 2.4 GitHub issue body template

Per-issue body must contain (in order):

1. **Summary** — 2-3 sentences: what & why
2. **User story** — As a X, I want Y, so that Z
3. **Links**
   - PRD path: `docs/prd-<slug>.md`
   - Plan path: `docs/plans/<slug>.md`
   - Per-story plan: `docs/stories/<slug>-<n>.md`
   - Memexia bank: `<bank-name>`
   - Sample query: `mcp__memexia__memexia_query {bank: "<bank-name>", q: "<story-topic>"}`
4. **Decisions locked for this story** — choices the implement agent should not relitigate
5. **Patterns to follow** — code install commands, libraries, skill names to preload
6. **Files to CREATE / UPDATE** — explicit list with action
7. **Task list** — atomic checkable steps
8. **Acceptance criteria** — what "done" looks like
9. **Dependencies / phase**
   - Greenfield projects: `phase:N-name` label
   - Existing projects: `Depends on: #X, #Y` body line

Use `<details>` collapsibles for any long-form sections so the issue stays skimmable.

### 2.5 Story ordering scheme

Combo of phase-labels and explicit dependencies:

- **Greenfield detection** — Workflow 3 checks for foundation files (`package.json`, `pyproject.toml`, `Cargo.toml`, etc.) AND a non-empty git log. If foundation files are absent → greenfield.
- **Greenfield path** — Stories get `phase:N-name` labels (`phase:0-foundation`, `phase:1-features`, `phase:2-polish`). Downstream picks lowest-numbered phase first.
- **Existing-project path** — Stories declare `Depends on: #X, #Y` in body. Downstream refuses to start if any blocker is open.
- Either path can use both signals when it helps.

## 3. Per-workflow spec

### 3.1 `archon-brainstorm-to-prd`

```
provider: claude
interactive: true
```

**Phase A — Bank setup (bash node)**
- Generate a slug from the input
- Call `memexia_bank_create` with bank name `<slug>-<YYYY-MM>`
- Output bank name for downstream nodes

**Phase B — Brainstorm + clarify loop (loop node, mirrors PIV's explore loop)**
- `interactive: true`, `until: PRD_DRAFT_READY`
- First iteration: AI listens, asks 4–6 targeted questions (not generic — must reference codebase findings)
- Subsequent iterations: process user's answers, save key decisions to Memexia bank, ask follow-ups
- Saves to Memexia: brainstorm raw, each Q&A round, decisions
- Exits loop when user explicitly approves moving to PRD draft

**Phase C — PRD draft (single prompt node, `context: fresh`)**
- Reads Memexia bank for full Q&A history
- Writes `docs/prd-<slug>.md` with frontmatter (slug, bank, paths, date)
- Sections: Summary, User Stories, Features, Edge Cases, Out of Scope, Success Criteria

**Phase D — PRD refine loop (mirrors PIV's refine-plan loop)**
- `interactive: true`, `until: PRD_APPROVED`
- User reviews PRD, gives feedback, AI iterates
- All revisions go to Memexia too

**Phase E — Commit + push (bash)**
- `git add docs/prd-<slug>.md && git commit -m "docs: PRD for <slug>" && git push -u origin HEAD`

### 3.2 `archon-prd-to-plan`

```
provider: claude
interactive: true
```

**Phase A — Load context (bash + prompt)**
- Validate PRD path exists, parse frontmatter, extract bank name
- Query Memexia bank for relevant context

**Phase B — Plan creation (prompt node, `context: fresh`)**
- Reads PRD + bank context + CLAUDE.md
- Writes `docs/plans/<slug>.md` (mirrors PIV's plan template — Summary, Mission, Success Criteria, Scope, Codebase Context, Patterns, Architecture, Task List, Testing Strategy, Validation Commands, Risks)

**Phase C — Plan refine loop**
- Mirrors PIV's `refine-plan` loop, `until: PLAN_APPROVED`
- Saves architectural decisions to Memexia bank as they're made

**Phase D — Commit + push**

### 3.3 `archon-plan-to-stories`

```
provider: claude
interactive: true
```

**Phase A — Load context + greenfield detection (bash)**
- Read PRD frontmatter (gets bank name) and plan
- Detect greenfield: check for foundation files + git log
- Output `MODE=greenfield` or `MODE=existing`

**Phase B — Story drafting + iteration loop**
- `interactive: true`, `until: STORIES_APPROVED`
- AI drafts each story into `docs/stories/<slug>-<n>.md` (one file per story)
- User reviews — can request: edit a story, regenerate one, reorder, add, remove, change dependencies
- AI keeps story files + dependency graph in sync as user iterates
- Saves per-story research to Memexia bank with tag `story-<n>`
- For greenfield: assigns `phase:N-name` per story
- For existing: builds `Depends on:` graph; validates no cycles

**Phase C — Issue creation (bash)**
- For each story file: `gh issue create` with body built from the issue template above
- Capture issue numbers, write back to story files (so the story file knows its issue number)
- Save issue-number → story-slug map to Memexia bank

**Phase D — Commit + push story files**

### 3.4 `archon-execute-story`

```
provider: claude
interactive: true
```

**Phase A — Dep-check (bash)**
- Input: issue number
- Fetch issue: `gh issue view <N> --json title,body,labels`
- Parse `Depends on: #X, #Y` from body
- For each blocker, check if open: `gh issue view <X> --json state`
- If any blocker is open → fail fast with a clear message listing the open blockers
- Extract bank name from issue body, validate PRD path + plan path exist

**Phase B — Prime (prompt node, `context: fresh`)**
- Loads issue body, fetches PRD + plan + per-story plan files
- Queries Memexia bank for story-specific research (`story-<n>` tag)
- Outputs a primed-context summary for the planner

**Phase C — Plan-confirm loop (lighter than PIV's full plan-creation)**
- `interactive: true`, `until: STORY_PLAN_APPROVED`
- AI confirms its understanding and the existing per-story plan; user can adjust before implementation

**Phase D — Implement loop (Ralph pattern, mirrors PIV's `implement` node)**
- `fresh_context: true`, `until: COMPLETE`, `max_iterations: 15`
- One task per iteration, validate before commit, no broken commits
- Tracks progress in `$ARTIFACTS_DIR/progress.txt`

**Phase E — Code review (mirrors PIV's `code-review`)**

**Phase F — Fix-feedback loop (mirrors PIV's `fix-feedback`)**
- `until: VALIDATED`

**Phase G — Finalize**
- Push branch, create PR with `Closes #<issue>` (auto-closes the issue on merge)
- Body references PRD path, plan path, per-story plan path, bank name

**Phase H — verify-pr-base (bash, mirrors PIV's last node)**

## 4. Files to create

| Path | Purpose |
|---|---|
| `.archon/workflows/archon-brainstorm-to-prd.yaml` | Workflow 1 |
| `.archon/workflows/archon-prd-to-plan.yaml` | Workflow 2 |
| `.archon/workflows/archon-plan-to-stories.yaml` | Workflow 3 |
| `.archon/workflows/archon-execute-story.yaml` | Workflow 4 |
| `.archon/mcp/memexia.json` | MCP config for Memexia |
| `docs/specs/prd-pipeline-workflows.md` | This spec |

`docs/prd-*.md`, `docs/plans/*.md`, `docs/stories/*.md` are runtime outputs, not authored at design time.

## 5. Memexia MCP config

The agent must inspect how Memexia is currently configured globally (the `mcp__memexia__*` tools available in Claude Code) and replicate that invocation in `.archon/mcp/memexia.json`. Likely shape:

```json
{
  "mcpServers": {
    "memexia": {
      "command": "<binary or npx invocation>",
      "args": ["..."],
      "env": { "...": "..." }
    }
  }
}
```

Refer to Archon's MCP guide: `https://archon.diy/guides/mcp-servers/`

Verify with:
```bash
archon workflow run archon-brainstorm-to-prd --branch test/mcp-check "test brainstorm"
# Confirm the first node has access to memexia_* tools
```

## 6. Branch / commit strategy

- **Workflows 1–3** use Archon's default worktree per the `--branch` flag. They commit, push, open a PR against `$BASE_BRANCH`, and **auto-merge** — first attempting an immediate squash-merge, then falling back to `gh pr merge --auto` if branch protection requires checks. After scheduling/completing the merge they poll `gh pr view` for up to 60 seconds (5 s interval) so the run only declares success once the merge is visible on base. If the cap is hit (slow CI or required human review) the workflow exits cleanly with `PR scheduled — run next workflow once <PR URL> merges`. The user does NOT merge by hand for docs workflows. Suggested branch names:
  - `docs/<slug>-prd`
  - `docs/<slug>-plan`
  - `docs/<slug>-stories`
- **Workflow 4** uses its own branch (`feat/<story-slug>` or similar). It produces code, so it keeps the standard human-reviewed PR flow — opens a PR with `Closes #<issue>`, does **not** auto-merge. The human reviews + merges in the GitHub UI.
- Workflow 4 expects artifacts on the base branch — the auto-merge in workflows 1–3 puts them there.

## 7. Reference patterns from `archon-piv-loop`

Adapt — don't blind-copy — these patterns:

- **`explore` loop** → use as the shape for Workflow 1's brainstorm-clarify loop
- **`create-plan` + `refine-plan`** → use as the shape for Workflow 2's plan creation + refine loop, and Workflow 1's PRD draft + refine loop
- **`implement-setup` + `implement` (Ralph loop)** → use directly in Workflow 4
- **`code-review` + `fix-feedback`** → use directly in Workflow 4
- **`finalize` + `verify-pr-base`** → use directly in Workflow 4

The trigger phrases (`PLAN_READY`, `PLAN_APPROVED`, `COMPLETE`, `VALIDATED`) and the strict "ONLY emit signal on explicit approval" rules in PIV are battle-tested — keep that exact discipline. New trigger names per workflow:

| Workflow | Loop trigger phrases |
|---|---|
| 1 | `PRD_DRAFT_READY`, `PRD_APPROVED` |
| 2 | `PLAN_APPROVED` |
| 3 | `STORIES_APPROVED` |
| 4 | `STORY_PLAN_APPROVED`, `COMPLETE`, `VALIDATED` |

## 8. Open questions / future work (non-blocking)

- **Direct doc upload to Memexia** — feature being added by Steven; not blocking. Once available, Workflow 1 could optionally upload the PRD into Memexia in addition to the repo file.
- **Multi-issue parallel execution** — out of scope for now. Each issue is a separate `archon-execute-story` invocation.

## 9. Acceptance criteria for the implementation work

- [ ] All four workflow YAMLs created and pass `archon validate workflows`
- [ ] `.archon/mcp/memexia.json` created and the workflows can call `memexia_*` tools without error
- [ ] End-to-end smoke test on a tiny example: brainstorm → PRD → plan → stories (creating issues on a test repo) → execute one story → PR
- [ ] Each workflow's loop signal discipline is verified (no early signal emission on questions/feedback)
- [ ] Greenfield mode and existing-project mode both produce well-formed issues
- [ ] Dep-check in Workflow 4 correctly refuses to start when a blocker is open
- [ ] PRD frontmatter is correctly parsed by Workflows 2, 3, 4
- [ ] `Closes #<issue>` in Workflow 4's PR body auto-closes the issue on merge
- [ ] All workflows surface useful errors when artifacts are missing or malformed (fail-fast, not silent)
