# Working in this repo

This file bootstraps every session. It does not document Archon — Archon documents itself at `packages/docs-web/src/content/docs/`. This file's job is to tell future-you **what we're doing here, where each kind of work belongs, and what not to do**, then point at the right reference for everything else.

---

## What we do here — three modes of work

This repo hosts **Archon** (a generic agentic-workflow runtime) and **Archie** (an autonomous SDLC pipeline built on top of it). Work in this directory falls into one of three modes. Knowing which mode you're in determines what discipline applies, what files you may edit, and where to look for context.

### Mode 1 — Platform code (Archon)

Modify the Archon runtime itself. TypeScript in `packages/`, Zod schemas, migrations, bundled defaults, CI scripts. Touching this code can change behavior for every workflow, every project, every user.

**Discipline:** branch from `main`, write tests, run `bun run validate` before opening a PR, follow the SDK / type / schema / logging conventions documented in `packages/docs-web/src/content/docs/contributing/`.

### Mode 2 — Workflow authoring (Archie)

Author and iterate on the YAML / prompts / scripts that the runtime executes. Lives entirely in `.archon/workflows/`, `.archon/commands/`, and `.archon/scripts/`. This is content, not engine code — fast iteration loop.

**Discipline:** validate workflows with `bun run cli validate workflows`, preserve prior runs (the "mark3 → mark4" pattern — copy the YAML to a new mark and edit there, leaving the prior mark frozen as a comparison reference), check artifacts on disk, treat the bundled `archon-*` commands as overridable but understand what each one does before shadowing it.

### Mode 3 — Operating downstream projects

Help Josh evaluate and act on the work product Archie is producing for whatever downstream project it is currently running against. Read Jira tickets, check workflow run status, kill runs that are going sideways, review the PRs Archie has opened, look at run artifacts on disk, decide what's good enough to ship. The downstream project's code lives in a *different* repo (e.g. `/home/user/ConflictCoach`) — this repo is the operating console.

**Discipline:** read across surfaces (Jira MCP, the project's own git repo, `~/.archon/workspaces/<owner>/<repo>/artifacts/runs/<runId>/`, `bun run cli workflow status`, GitHub via `gh`). Take operational actions when needed (`bun run cli workflow abandon <runId>`, Jira transitions/comments via the MCP, PR reviews via `gh`). Confirm before destructive operations (killing a long-running workflow, transitioning a Jira ticket, force-closing a PR). **Don't edit Archon source or Archie YAML in Mode 3** — if a Mode 3 finding implies a code or workflow change, name the crossing explicitly: *"this Mode 3 observation implies a Mode 2 change to <X>"* — then switch discipline deliberately rather than silently editing.

### Crossing modes

The modes form a hierarchy: Mode 3 sits on Mode 2 sits on Mode 1. A Mode 3 observation often surfaces a Mode 2 gap; a Mode 2 need sometimes surfaces a Mode 1 gap. Always **name the crossing explicitly** when you notice one — say "this is a Mode 1 change now," confirm with Josh before scope-jumping, and switch to the corresponding discipline (Mode 1 = PR + tests; Mode 2 = preserve-prior-mark + validate; Mode 3 = confirm-before-destructive).

---

## Mode 1 reference: the Archon platform

Archon's API surface is large enough that documenting it here would duplicate (and rot relative to) `packages/docs-web/src/content/docs/`. Read the docs site for anything substantive. Useful entry points:

- `getting-started/concepts.md` and `getting-started/overview.md` — the mental model
- `reference/architecture.md` — system overview
- `reference/cli.md`, `reference/api.md`, `reference/configuration.md`, `reference/database.md`, `reference/variables.md`, `reference/commands.md`, `reference/archon-directories.md` — the canonical references
- `guides/authoring-workflows.md`, `guides/authoring-commands.md`, `guides/loop-nodes.md`, `guides/approval-nodes.md`, `guides/script-nodes.md`, `guides/hooks.md`, `guides/skills.md`, `guides/mcp-servers.md` — workflow-engine deep dives
- `adapters/` — per-platform adapter docs (Slack, Telegram, GitHub, Web, Discord, Gitea, GitLab)
- `contributing/new-developer-guide.md`, `contributing/cli-internals.md`, `contributing/dx-quirks.md`, `contributing/adding-a-community-provider.md` — contribution guides
- `book/` — long-form conceptual walkthrough for new readers
- `reference/troubleshooting.md` — when something is going wrong

When the docs disagree with the code, the code is truth — file or fix the doc afterward.

### Mode 1 load-bearing rules (the things even the docs may not surface)

Things that will bite you if you don't know them:

- **`main` is the working branch.** Branch from `main`, PR into `main`. CLAUDE.md previously claimed a `dev` → `main` flow; that is not how this repo actually operates.
- **Run `bun run validate` before every PR.** It executes `check:bundled` + `type-check` + `lint` + `format:check` + tests — the same five checks CI runs.
- **After editing anything under `.archon/commands/defaults/` or `.archon/workflows/defaults/`, run `bun run generate:bundled`.** The generated file `packages/workflows/src/defaults/bundled-defaults.generated.ts` is what binary builds embed. `bun run validate` fails loud if it's stale.
- **Test isolation is fragile.** Bun's `mock.module()` permanently mutates the process-wide module cache; `mock.restore()` does NOT undo it ([oven-sh/bun#7823](https://github.com/oven-sh/bun/issues/7823)). Packages with conflicting `mock.module()` calls split tests across multiple `bun test` invocations — see each `package.json`. **Never run `bun test` from the repo root**; use `bun run test` (per-package isolated processes). For internal modules other test files import directly, prefer `spyOn()` (its `mockRestore()` works) over `mock.module()`.
- **Lifecycle-mutation rule.** A process that cannot reliably distinguish "running elsewhere" from "orphaned by a crash" must NOT auto-mark non-terminal work as failed/cancelled based on a timer. Surface ambiguity to the user with a one-click action. Recoverable heuristics (retry backoff, subprocess timeouts, hygiene cleanup of *terminal*-status data) remain fine. Reference: #1216 and `packages/cli/src/cli.ts:256-258`.
- **Never run `git clean -fd`.** It permanently deletes untracked files. Use `git checkout .` instead.
- **Schemas and OpenAPI:** all new/modified API routes must use `registerOpenApiRoute(createRoute({...}), handler)`. Import `z` from `@hono/zod-openapi`, never from `zod` directly. Always derive types via `z.infer<typeof schema>`. Route schemas live in `packages/server/src/routes/schemas/`; engine schemas in `packages/workflows/src/schemas/`.
- **`@archon/web` never imports from `@archon/workflows`.** The web package consumes generated types from `src/lib/api.generated.d.ts` (regenerated via `bun --filter @archon/web generate:types` against a running server). Workflow types are re-exported from `@/lib/api`.
- **Logging: `{domain}.{action}_{state}`** — pair every `_started` with `_completed` or `_failed`. Never log API keys, tokens, user message content, or PII. See `packages/paths/src/logger.ts`.
- **Fail fast.** Throw early with explicit messages on unsafe states. Don't silently broaden permissions, don't silently swallow errors. Document any intentional fallback with a comment.
- **Trust git's guardrails.** Use `@archon/git` functions; if calling git directly, use `execFileAsync`, never `exec`. Don't paper over git's "refuse to remove worktree with uncommitted changes" — that's the right behavior.

### Mode 1 dev workflow

```bash
bun run dev            # server (3090) + web UI (5173) hot reload
bun run dev:server     # backend only
bun run dev:web        # frontend only

bun run test           # all tests, per-package isolated processes
bun run type-check
bun run lint
bun run format

bun run validate       # the pre-PR check — same five checks CI runs
bun run generate:bundled   # after editing default workflows/commands
```

Worktrees auto-allocate a deterministic port (3190–4089, hash-based on path) so parallel agents don't collide; main repo stays on 3090. Same worktree always gets the same port.

---

## Mode 2 reference: workflow authoring (Archie)

Most of what you need to know about authoring workflows is in `packages/docs-web/src/content/docs/guides/`. Beyond that, **the Archie-specific operational reference lives in `.archon/`:**

- **`.archon/ARCHIE_PIPELINE.md`** — read top-to-bottom on first encounter. The canonical operational reference: workflow chain, task-implement DAG with rationale, script inventory, validation contract, pause-label semantics, reset/cleanup recipes, log/DB queries, open-items backlog. Grep alone misses cross-script logic.
- **`.archon/ARCHIE_PRD.md`** — what Archie is and why it's shaped this way. Read when reasoning about design intent or proposing pipeline changes.
- **`.archon/ARCHIE_V2_BACKLOG.md`** — concrete in-scope v2 enhancements with implementation steps. Read when planning v2 engine/workflow work.
- **`.archon/ARCHIE_V2_PR_PLAN.md`** — ordered PR sequence for in-flight v2 work. Read when actively shipping.
- **`.archon/ARCHIE_V3_CANDIDATES.md`** — post-v2 architectural-rewrite parking lot. Read only when long-term planning, or appending new friction.

### Mode 2 load-bearing rules

- **Validate before running.** `bun run cli validate workflows <name>` (or with no name for all). Catches schema errors and missing referenced resources (commands, MCP configs, skill dirs).
- **Preserve prior runs.** When iterating on a workflow that has produced a meaningful run, **copy the YAML to a new mark** (`v2-epic-decomposition-mark3.yaml` → `mark4.yaml`) and edit there. Don't mutate in place — the prior mark is the reference for comparison. Any edits to the prior mark invalidate that comparison.
- **Files, not env vars, between nodes.** Pass cross-node data through `$ARTIFACTS_DIR` files, not via env exports interpolated into YAML. The `$nodeId.output` substitution exists, but for anything more complex than a single value (or anything you want to be debuggable across runs), files are the right primitive.
- **Single-purpose agent prompts.** Each command / prompt node should do one atomic task. Don't leak the rest of the pipeline into a node's prompt.
- **Defensive normalization at consumer boundaries.** Case, whitespace, and quoting variation from agents is just untrusted input — normalize at the consumer, don't try to tighten the upstream prompt.
- **DAG fan-in default is `trigger_rule: all_done`** for merge / synthesize / aggregate nodes — they are the failure-aware nodes. Not `one_success`, not `none_failed_min_one_success`.
- **Tickets are the spec; tests are instruments.** Acceptance criteria are the standard for "done"; gates detect drift; the ticket tells agents what to write so they don't have to spelunk the repo.

---

## Mode 3 reference: operating downstream projects

Mode 3 is operations against external state. The tooling:

- **Run status:** `bun run cli workflow status` for in-flight runs; `bun run cli workflow list` for available workflows.
- **Kill a run:** `bun run cli workflow abandon <runId>` (the only correct way — never `UPDATE` the DB directly; see auto-memory `feedback_no_direct_db_edits.md`).
- **Resume a failed run:** `bun run cli workflow resume <runId>` re-runs, skipping completed nodes.
- **Run artifacts:** `~/.archon/workspaces/<owner>/<repo>/artifacts/runs/<runId>/` — `feedback.json`, `dev-review-*.json`, `task-context.md`, `attachments.md`, `pr-info.json`, etc.
- **Run logs:** `~/.archon/workspaces/<owner>/<repo>/logs/<runId>.jsonl` and the global `/home/user/Archon/logs/archon.log`.
- **DB read-only diagnostics:** SQLite at `~/.archon/archon.db`. `SELECT` only — see `ARCHIE_PIPELINE.md` for the canonical "in-flight runs" query.
- **Jira:** prefer the `mcp__atlassian-mcp__*` tools for ticket reads, transitions, comments, label edits, link creation. For bulk operations, the Archie scripts in `.archon/scripts/jira-*.ts` are the Jira-API-tested helpers; **call them from `/home/user/Archon`, not from a downstream-project cwd** (env-strip wipes Jira creds in foreign cwds).
- **GitHub:** `gh pr view`, `gh pr review`, `gh pr merge`. Note: the classic PAT in `/home/user/Archon/.env` (`GH_TOKEN`) is what works for merge — the fine-grained PAT in `~/.config/gh/hosts.yml` cannot merge PRs.

For anything Archie-specific (reset recipes, common gotchas, the sweep semantics, the pause-label pattern), **`.archon/ARCHIE_PIPELINE.md` has it** — that doc was written precisely as the Mode 3 playbook.

For ticket-specific operational state (e.g. "WOR-88 is blocked on Resend domain verification"), check auto-memory before re-deriving — Josh stores these as `project_*` memories.

---

## Where to look first, by question

| Question | Read |
|---|---|
| How does Archon's <feature> work? | `packages/docs-web/src/content/docs/` — appropriate `reference/` or `guides/` page |
| What does Archie do? Why is it shaped this way? | `.archon/ARCHIE_PRD.md` |
| How does Archie actually run? Reset recipe? Open bugs? | `.archon/ARCHIE_PIPELINE.md` |
| What v2 work is planned / in-flight? | `.archon/ARCHIE_V2_BACKLOG.md`, `.archon/ARCHIE_V2_PR_PLAN.md` |
| What would I redesign post-v2? | `.archon/ARCHIE_V3_CANDIDATES.md` |
| What's the status of WOR-N / a specific ticket? | Jira MCP + auto-memory |
| What's running right now? | `bun run cli workflow status` |
| Where did this run's artifacts land? | `~/.archon/workspaces/<owner>/<repo>/artifacts/runs/<runId>/` |
| What does endpoint X return? | `GET /api/openapi.json` (the live spec is truth, not a hand-written list) |

---

## Don't

- Edit Archon source from Mode 3.
- Run `bun test` from the repo root.
- Run `git clean -fd`.
- `UPDATE` `~/.archon/archon.db` directly to fix CLI gaps — file the bug instead.
- Mutate a prior mark of an experimental workflow that has a successful run on record.
- Auto-mark non-terminal work failed/cancelled based on a timer.
- Log API keys, tokens, user message content, or PII.
- Skip `bun run generate:bundled` after editing bundled defaults.
- Skip `bun run validate` before opening a PR.
- Cross modes silently — name the crossing and confirm before scope-jumping.
