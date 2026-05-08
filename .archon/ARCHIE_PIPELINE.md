# Archie Pipeline — Operational Reference

**When to read this:** before doing any Mode 2 (workflow authoring) or Mode 3 (operating runs) work on Archie. This is the canonical reference for *how Archie actually runs today* — workflow chain, task-implement DAG with rationale, scripts inventory, validation contract, pause-label semantics, reset/cleanup recipes, log/DB queries, and the open-items backlog of Mode-1 patches that Mode-2 work has surfaced. Read top-to-bottom on first encounter; grep alone misses cross-script logic.

Companion docs: `ARCHIE_PRD.md` (system-as-built spec), `ARCHIE_V2_BACKLOG.md` (planned engine improvements), `ARCHIE_V2_PR_PLAN.md` (PR sequence for in-flight work), `ARCHIE_V3_CANDIDATES.md` (post-v2 architectural rewrites).

---

## Project vision

**Archie** is an attempt to run software delivery as an autonomous lean
production line. The premise: a single human (or small team) defines the
product's intent in a Jira Epic — PRD, TechSpec, design doc, acceptance
criteria — and the rest of the SDLC happens without humans touching code.
Tests, implementation, code review, fixes, merge, ticket lifecycle: all
deterministic when possible, agent-driven when not, with explicit human
escape hatches.

The architectural commitments that fall out of this:

- **Jira is the source of truth.** Tickets are the queue; transitions are
  the events that drive work; labels are the signaling channel. Humans
  interact with Jira normally — they don't need to know about Archon.
- **Each agent does one thing.** The dev agent writes code. The reviewer
  agents review. The synthesizer aggregates findings. None of them
  shoulder the others' jobs. Prompts stay tight; cross-station context
  belongs in YAML wiring, not in the agent's head.
- **Deterministic gates between agents.** Lint, typecheck, vitest,
  playwright are objective verdicts on the dev agent's work. The dev
  agent doesn't get to decide whether tests pass; the validator does.
  This is the Toyota Production System "Jidoka" idea — quality is
  built in at each station, not inspected at the end.
- **Acceptance criteria are the contract.** Tests are instruments that
  detect drift from the AC; lint and typecheck are quality gates; the
  reviewer's verdict is a gate. None of these are the *spec*. The
  ticket's AC is the spec, end-of-story.
- **The pipeline runs day and night.** The intent is for someone to seed
  an Epic on Friday, walk away, and find a project's worth of merged
  PRs on Monday. This works only because (a) the pipeline retries
  intelligently, (b) it surfaces real problems via labels rather than
  silently dropping work, and (c) it parallelizes wherever the DAG
  permits — multiple tickets can be in flight simultaneously, each in
  its own git worktree.
- **A human can always intervene.** The `archon-blocked-pending` label
  is an Andon cord — slap it on a ticket and the pipeline leaves it
  alone. Remove the label and the pipeline picks it up on the next
  sweep. There's no special "needs human" state machine; it's just a
  Jira label.

This is a POC, currently exercised against **ConflictCoach** (Jira project
`WOR`, repo `joshuarossi/ConflictCoach`) — a greenfield Vite + React +
Convex app. The Epic `WOR-5` ("Conflict Coach v1") was decomposed into 50+
child tickets and many have been merged autonomously through the pipeline,
including: WOR-23 (project scaffolding), WOR-24 (design tokens), WOR-25
(Convex schema), WOR-28 (error normalization), WOR-29 (lifecycle state
machine), WOR-39 (AI streaming), WOR-41 (chat UI components), WOR-42
(privacy banner), WOR-65 (Convex provider), and others.

---

## Goal

Drive a Jira project end-to-end without humans touching code:

1. Human writes an Epic with PRD + TechSpec attachments, transitions
   `Backlog → Selected for Development`.
2. `epic-decompose` produces N child Tasks with Blocks links between them.
3. As each Task transitions through SDLC states, Archon workflows handle
   tests, implementation, review, merge, and downstream-unblocking.
4. The wave of unblocked tickets cascades automatically; a human steps in only
   when something genuinely needs judgment (the `archon-blocked-pending`
   pause label).

The target project for the POC is **ConflictCoach**
(`/home/user/ConflictCoach` ↔ Jira project `WOR`). The Epic is `WOR-5`; the
scaffolding child is `WOR-23`.

---

## Branch / repo layout

- We work on `feature/jira-adapter` in `/home/user/Archon`.
- The pipeline operates on `/home/user/ConflictCoach` (a separate git repo).
  The Archon adapter clones / opens worktrees there.
- Commits land on a `main` branch in ConflictCoach via squash-merged PRs.
- Archon's workspace tree:
  - `~/.archon/workspaces/joshuarossi/ConflictCoach/artifacts/runs/<run-id>/` —
    per-run artifact directory (`$ARTIFACTS_DIR`)
  - `~/.archon/workspaces/joshuarossi/ConflictCoach/logs/<run-id>.jsonl` —
    per-run JSONL log
  - `~/.archon/workspaces/user/ConflictCoach/worktrees/archon/task-wor-N` —
    git worktrees, one per ticket

---

## Workflow chain

The pipeline is five Archon workflows wired together via Jira webhook
transitions. The router decides what to dispatch on each transition.

```
Jira webhook
   │
   ▼
jira-router (worktree: false, mutates_checkout: false)
   ├── route-epic-decompose      (Epic, Backlog → Selected for Dev)
   ├── route-task-tests          (non-Epic, Backlog → Selected for Dev)
   ├── route-task-implement      (non-Epic, Selected for Dev → In Progress)
   └── route-task-done           (non-Epic, * → Done)
```

### 1. `epic-decompose.yaml`

Triggered by `Epic Backlog → Selected for Development`. Reads PRD/TechSpec
attached to the Epic, produces N child Tasks via the Jira API, creates
`Blocks` links between them, labels every child `archon-blocked-pending` so
nothing fires until decomposition is fully wired. Then strips the label
from root tasks (those with no inward Blocks) and transitions each to
`Selected for Development`.

### 2. `task-tests.yaml`

Triggered by non-Epic `Backlog → Selected for Development`. Generates
failing tests for the ticket's acceptance criteria. The test-gen agent
also handles its own infrastructure setup (`npm install`,
`playwright install`, etc.). Writes tests under `tests/<issue-key>/` and
`e2e/<issue-key>/` (case-insensitive matching downstream so any case works).
Pushes to `archon/task-<issue-key>` branch, transitions ticket to
`In Progress`. The transition fires the next webhook.

### 3. `task-implement.yaml`

Triggered by non-Epic `Selected for Development → In Progress`. The full
end-to-end dev pipeline. Detailed below.

### 4. `task-done.yaml`

Triggered by non-Epic `* → Done`. Runs `jira-task-done.ts` which:
1. Deletes this ticket's outward `Blocks` links (which auto-removes
   matching inward `is blocked by` on dependents).
2. JQL-sweeps the project for `Backlog non-Epic, no inward Blocks, no
   archon-blocked-pending label` and transitions each to
   `Selected for Development`. The sweep is **project-scoped**, not
   limited to "tickets we just unblocked" — anything Backlog with no
   blockers gets picked up.
3. If the parent Epic has zero remaining non-Done children, transitions
   the Epic to `Done` (epic rollup).
4. Posts a Jira comment summarizing what happened.

`worktree.enabled: false` and `mutates_checkout: false` so multiple Done
events fire concurrently without queueing.

### 5. `jira-router.yaml`

Tiny dispatcher. Decodes the base64 webhook payload and `archon workflow
run`s the right downstream workflow with `--cwd <repo>` and
`--branch <issue-key>`. Pure metadata operation — `worktree.enabled: false`
and `mutates_checkout: false` so concurrent webhook events don't serialize.

---

## task-implement DAG (the meat)

```
decode → write-trigger-artifact → fetch-task-context → fetch-epic-tech-context
   │
   ▼
rebase-on-main                           ← branch ALWAYS starts on current main
   │                                       (sibling tickets that merged after
   ▼                                        test-gen ran are now visible; no
dev-attempt-1 (caged) → validate-1        stale-base illusion)
   │ when v1 failed
   ▼
dev-attempt-2 (caged) → validate-2
   │ when v2 failed
   ▼
dev-attempt-loop (no cage; max 5 iter)   ← OR-exits via <COMPLETE> token OR
   │                                       until_bash (validation passes)
   ▼
validate-loop                            ← deterministic re-validate after loop;
   │                                       authoritative `passed` for downstream
   ▼
generate-docs                            ← only fires when ANY validate passed
   │
   ▼
open-pr                                  ← gh pr create (--auto removed)
   │
   ▼
setup-review-context
   │
   ├── review-scope          ┐
   ├── review-code           │
   ├── review-error-handling │  parallel reviewers
   ├── review-docs           │
   └── review-comment-quality┘
                              ↓ trigger_rule: all_done
synthesize  (bundled archon-synthesize-review)
   │
   ▼
parse-synthesis  (.archon/scripts/task-parse-synthesis.ts — emits clean
   │              JSON `{decision: approve | changes_requested | needs_discussion}`
   │              from the synthesizer's prose verdict)
   ▼
implement-fixes  (OUR command: task-implement-fixes, NOT bundled)
   │ when decision == 'changes_requested'
   ▼
post-fix-validation
   │
   ▼
merge-pr  (bash guards on pr-info.json existence; squash + delete-branch;
   │       no --auto flag — repo doesn't allow auto-merge)
   ▼
transition-to-done → log-elapsed-on-task
```

Each validation node first runs a deterministic generated-test cleanup
preflight. That preflight removes only TypeScript-reported unused
`@ts-expect-error` directives from this ticket's generated tests and commits the
cleanup before lint/typecheck/test gates run. This lets test-gen use temporary
red-state suppressions for not-yet-written imports without trapping the dev
agent, who remains forbidden from editing tests.

### Key non-obvious decisions

- **`rebase-on-main` runs BEFORE dev-attempt-1**, not after open-pr. If the
  branch base is stale, validate-1 fails on sibling-ticket tests
  (illusory "you deleted X" findings) and the chain cascades to skips
  before ever reaching the rebase node. Doing it first eliminates the
  illusion at the source.

- **`denied_tools` cage** on dev-attempt-1, dev-attempt-2, and implement-fixes
  blocks `Read/Write/Edit/Glob/LS` on `tests/**`, `e2e/**`, `*.test.*`,
  `*.spec.*`, etc., plus `Bash(npm test:*)`, `Bash(npx vitest:*)` etc. The
  cage is **partially defeated by Bash** — `cat tests/...`, `find tests`,
  `node ./node_modules/.bin/vitest`, etc. all bypass it. Prompt-level
  imperative rules (DO NOT READ TESTS / DO NOT RUN TESTS / DO NOT ASK) are
  the secondary defense. Real fix is patching Archon to support
  script-based hooks (deferred — see [Open Items](#open-items-and-known-bugs)).

- **dev-attempt-loop has NO cage** — Archon's loop nodes strip
  `LOOP_NODE_AI_FIELDS`, so `denied_tools` and `hooks` defined on a loop
  node are silently dropped. By the time we're in the loop, two
  cage-enforced attempts have already failed; the loop's job is
  convergence, the prompt is the only enforcement.

- **synthesize uses `trigger_rule: all_done`** so it fires even when
  individual reviewers fail. The rationale was "synthesize is the
  failure-aware node — it should see the full reviewer state including
  failures." But: when ALL reviewers were skipped via cascade (e.g.
  validate-2 failed → generate-docs skipped → open-pr skipped →
  setup-review-context skipped → 5 reviewers skipped on trigger_rule),
  the bundled synthesize **fabricates a complete review** including
  fake severity counts and made-up `file:line` references. We've seen
  this twice. See [Open Items](#open-items-and-known-bugs).

- **merge-pr's bash guards on pr-info.json** rather than encoding it in
  the `when:` clause, because Archon's condition evaluator has no
  parentheses (would have required duplicating
  `$open-pr.output.pr_number != ''` in every OR branch). Cleaner to
  guard at the consumer.

- **Per-ticket changelog fragments** (`.changelog/<key>.md`) in
  `generate-docs`'s prompt instead of editing a shared `CHANGELOG.md`.
  Eliminates merge conflicts when N tickets run in parallel — every
  parallel branch was hitting `CHANGELOG.md` conflicts.

---

## Scripts

All under `.archon/scripts/`. Convention: stdout = JSON-only when the
output is consumed by a downstream node's `when:` clause; narrative goes
to stderr. The validation script uses `exec 3>&1 1>&2` to enforce this.

### Workflow node helpers

| script | called by | purpose |
|---|---|---|
| `task-prepare-branch.ts` | task-tests | check out the per-ticket branch from a fresh main |
| `task-checkout-branch.ts` | task-tests | (alt. branch logic) |
| `task-verify-tests-exist.ts` | task-tests | halt the test-gen workflow if zero test files were committed |
| `task-commit-push.ts` | task-tests | stage test-shaped files, commit, push to origin |
| `task-transition-to-done.ts` | task-tests | transition the ticket to `In Progress` (which fires task-implement) |
| `task-run-validation.sh` | task-implement (validate-1, validate-2, validate-loop, post-fix-validation) | run generated-test cleanup, lint/typecheck/scoped-vitest/scoped-playwright; emit per-attempt JSON; reads ISSUE_KEY from `trigger-payload.json`, auto-detects attempt number from existing `feedback.attempt-*.json` files. Always exits 0 except inside dev-attempt-loop's until_bash where exit code derives from overall status |
| `task-cleanup-obsolete-ts-expect-error.ts` | task-run-validation.sh preflight | removes TypeScript-reported unused `@ts-expect-error` directives from this ticket's generated tests and commits that cleanup before validation gates run |
| `task-open-pr.ts` | task-implement | push branch, open PR via `gh pr create`, write `pr-info.json` |
| `task-parse-synthesis.ts` | task-implement (parse-synthesis) | read `consolidated-review.md`, grep verdict (APPROVE / REQUEST_CHANGES / NEEDS_DISCUSSION), emit `{decision: approve \| changes_requested \| needs_discussion}` JSON. Fail-closed to `changes_requested` on missing/unparseable input |
| `task-merge-pr.ts` | task-implement (merge-pr) | squash-merge via `gh pr merge --squash --delete-branch` (no `--auto`); fetch the merge SHA; post Jira comment |

### Jira API helpers

| script | purpose |
|---|---|
| `jira-tool.js` | the workhorse — supports `getIssue`, `transitionIssue`, `addComment`, `editLabels`, `createIssue`, `createIssueLink`, `deleteIssueLink`, `addAttachment`, `addWorklog`, `downloadAttachment`, `batch`. Reads `JIRA_BASE_URL`, `JIRA_USER_EMAIL`, `JIRA_API_TOKEN` from env. ⚠ env-stripping in ConflictCoach cwd — call from `/home/user/Archon` or pass env explicitly |
| `jira-fetch-epic.ts` | fetch Epic + write to `parent-epic-context.md` |
| `jira-fetch-attachments.ts` | download Jira attachments, render to `attachments.md` |
| `jira-fetch-task-context.ts` | fetch a single task → `task-context.md` |
| `jira-render-plan-md.ts` | render a decomposition plan to markdown |
| `jira-attach-plan.ts` | attach a plan markdown to an Epic |
| `jira-create-blocks-links.ts` | bulk-create Blocks links from a plan |
| `jira-delete-blocks-links.ts` | bulk-delete Blocks links |
| `jira-cleanup-children.ts` | delete Archon-created child tickets (heuristic: `archon-blocked-pending` label presence) |
| `jira-unblock-roots.ts` | strip `archon-blocked-pending` from tasks with no declared blockers; transition them to `Selected for Development` |
| `jira-unstick-rest.ts` | strip `archon-blocked-pending` from tasks with declared blockers (they stay in Backlog until blockers Done) |
| `jira-transition-task-to-in-progress.ts` | helper: transition issue to In Progress |
| `jira-final-comment.ts` | post a final summary comment after work is merged |
| `jira-log-elapsed.ts` | append elapsed-time worklog to a ticket |
| **`jira-task-done.ts`** | the task-done handler — deletes outward Blocks, project-sweeps + promotes unblocked tickets, rolls up the parent Epic if all children Done. JQL filter excludes `archon-blocked-pending` |

---

## Commands

`.archon/commands/` — repo-level commands win over bundled defaults at the
same name. New names (no shadow needed) are simpler when we want a clean
break.

| command | used by | what |
|---|---|---|
| `task-implement-fixes.md` | task-implement (implement-fixes node) | OUR autonomous-pipeline-tailored fix-implementer. Fixes EVERY actual issue (any severity); only defers literal questions ("do you want X or Y?") to humans. Replaces the bundled `archon-implement-review-fixes` which is built for human-in-the-loop and skips MEDIUM/LOW |
| `archon-synthesize-review` (bundled) | task-implement (synthesize node) | bundled — generates consolidated review markdown, posts as PR comment. **Has the hallucinate-when-deps-skipped bug.** Future: own version, see Open Items |
| `archon-code-review-agent` etc. (bundled) | task-implement (5 reviewer nodes) | bundled — each reviewer reads PR diff + scope, writes findings markdown. Working OK |

---

## Validation contract

The single source of truth for "did the dev agent's code work" is
`task-run-validation.sh`. It runs four gates in order:

1. **lint** — only if `package.json` has a `lint` npm script
2. **typecheck** — only if `package.json` has a `typecheck` npm script
3. **vitest** — only if `tests/<issue-key-case-insensitive>/` directory exists
4. **playwright** — only if `e2e/<issue-key-case-insensitive>/` directory exists

Output:

- `$ARTIFACTS_DIR/feedback.attempt-{N}.json` — per-attempt audit trail
- `$ARTIFACTS_DIR/feedback.json` — copy of the latest (stable path for prompts)
- `$ARTIFACTS_DIR/test-results/attempt-{N}/{name}.log` — per-gate logs

Stdout is the JSON-only line `{passed:"true|false", issue_key, report}` —
read by downstream `when:` clauses. Narrative goes to stderr.

Project-agnostic: it runs whatever the project defines. Setup
(`npm install`, `npx playwright install`) is the **dev/test-gen agent's
job**, not the validator's. If the dev didn't install a runner, the gate
fails for an environmental reason, that's a real failure signal in
feedback.json, dev-attempt-2/loop sees it and addresses it.

---

## Pause / human-needed pattern

**The label `archon-blocked-pending` is the pause signal.** When set on
a ticket:

- `task-done`'s sweep JQL excludes it (`labels not in
  ("archon-blocked-pending")`), so the ticket sits quiet in Backlog.
- The router's `route-task-tests` only fires on
  `Backlog → Selected for Development`, which doesn't happen if the
  ticket isn't promoted — net effect, nothing happens.
- A human removes the label by hand to release the ticket.

JQL gotcha encoded in `jira-task-done.ts`: `labels != X` is interpreted
as "labels exist AND none equal X" — silently excludes UNLABELED tickets.
Use `(labels is EMPTY OR labels not in (X))` for the correct
"doesn't have this specific label" semantics.

---

## Local environment

### Tokens

`/home/user/Archon/.env`:

```
GH_TOKEN=ghp_...        # classic PAT — has merge-PR permission. Required.
GITHUB_TOKEN=ghp_...    # same value, used by GitHub adapter
JIRA_BASE_URL=https://alphapoint.atlassian.net
JIRA_USER_EMAIL=jeff.tangowski@aplab.ai
JIRA_API_TOKEN=...
JIRA_WEBHOOK_SECRET=...
```

`gh auth status` shows a fine-grained PAT in `~/.config/gh/hosts.yml` —
that one CAN'T merge PRs. The classic `ghp_...` from `.env` is what
works. When merging from a shell, `export GH_TOKEN=ghp_...` first.

### Reset / cleanup recipe

When a ticket needs a full restart:

```bash
# Close PR (auto when branch deletes; explicit fallback)
gh pr close <PR#> --repo joshuarossi/ConflictCoach

# Delete remote + local branch
cd /home/user/ConflictCoach
git push origin --delete archon/task-wor-<N>
git branch -D archon/task-wor-<N>

# Remove worktree
git worktree remove --force /home/user/.archon/workspaces/user/ConflictCoach/worktrees/archon/task-wor-<N>

# Transition Jira → Backlog (run from /home/user/Archon, NOT from ConflictCoach,
# because the cwd's strip-cwd-env wipes JIRA_* env vars in ConflictCoach)
cd /home/user/Archon
bun .archon/scripts/jira-tool.js '{"action":"transitionIssue","issueKey":"WOR-<N>","toStatus":"Backlog"}'

# Verify zero resumable rows
bun -e 'import { Database } from "bun:sqlite";
const db = new Database("/home/user/.archon/archon.db", { readonly: true });
const r = db.query(`SELECT id, status FROM remote_agent_workflow_runs WHERE working_path = ? AND (status IN ("failed","paused") OR (status = "running" AND last_activity_at < datetime("now","-3 days")))`).get("/home/user/.archon/workspaces/user/ConflictCoach/worktrees/archon/task-wor-<N>");
console.log(r ?? "no resumable row");'

# Re-trigger
bun .archon/scripts/jira-tool.js '{"action":"transitionIssue","issueKey":"WOR-<N>","toStatus":"Selected for Development"}'
```

### Bulk-label all Backlog tickets (pause pipeline)

```bash
bun -e '
const auth = Buffer.from(`${process.env.JIRA_USER_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString("base64");
const jql = encodeURIComponent("project = WOR AND status = \"Backlog\"");
const r = await fetch(`${process.env.JIRA_BASE_URL}/rest/api/3/search/jql?jql=${jql}&fields=summary&maxResults=200`, { headers: { Authorization: `Basic ${auth}`, Accept: "application/json" } });
const keys = (await r.json()).issues.map(i => i.key);
for (const key of keys) {
  await Bun.spawn({ cmd: ["bun", "/home/user/Archon/.archon/scripts/jira-tool.js", JSON.stringify({ action: "editLabels", issueKey: key, add: ["archon-blocked-pending"] })] }).exited;
}
console.log("labeled", keys.length);
'
```

To unpause: same script with `remove` instead of `add`.

---

## Operational tips

### Reading the workflow log

`/home/user/Archon/logs/archon.log` — JSONL format, every event Archon emits.
Useful filters:

```bash
# Workflow lifecycle events
grep -E '"msg":"(workflow_started|workflow_completed|workflow_failed|node_started|node_completed|node_failed|node_skipped)"' /home/user/Archon/logs/archon.log | tail -50
```

### Reading run state from DB

`~/.archon/archon.db` — SQLite. Read-only `SELECT` is fine and necessary
for diagnostics. Mutations (`UPDATE`, `INSERT`, `DELETE`) — DON'T. Always
use `archon workflow abandon` for state changes.

```bash
# In-flight runs
bun -e '
import { Database } from "bun:sqlite";
const db = new Database("/home/user/.archon/archon.db", { readonly: true });
const r = db.query(`SELECT id, workflow_name, status, started_at, last_activity_at, user_message FROM remote_agent_workflow_runs WHERE status IN ("running","pending","paused") ORDER BY started_at ASC`).all();
for (const x of r) {
  let key = ""; try { key = JSON.parse(Buffer.from(x.user_message,"base64").toString("utf8")).issue_key||""; } catch {}
  console.log(`  ${x.workflow_name.padEnd(15)} ${key.padEnd(8)} ${x.status.padEnd(10)} started ${x.started_at} last_activity ${x.last_activity_at}`);
}'
```

### Trigger a run manually

If a router event was lost or you want to re-fire without going through
Jira, you can dispatch a workflow directly:

```bash
payload='{"event":"transition","issue_key":"WOR-26","project":"WOR","codebase_cwd":"/home/user/ConflictCoach","issue_type":"Task","summary":"...","status":"In Progress","from_status":"Selected for Development","to_status":"In Progress","actor":"manual"}'
encoded=$(printf '%s' "$payload" | base64 -w0)
nohup archon workflow run task-implement \
  --cwd /home/user/ConflictCoach \
  --branch WOR-26 \
  "$encoded" \
  >/tmp/redispatch.log 2>&1 &
```

---

## Open items and known bugs

### Synthesize hallucinates when ALL reviewers skipped

When validate-2 fails → generate-docs skipped → open-pr skipped →
reviewers skipped via trigger_rule cascade. Synthesize fires anyway
(its `trigger_rule: all_done` ignores skips) and fabricates an entire
consolidated review including fake severity counts and made-up
`file:line` references. We've seen this on at least two runs (the WOR-45
case actually had synthesize **open the PR itself** via `gh pr create`,
because the bundled command compensates aggressively when prerequisites
are missing).

**Fix shape (deferred)**: add a guard node `verify-reviewer-artifacts`
between the reviewers and synthesize that fails if zero
`*-findings.md` files exist on disk. Synthesize then skips via its
default `all_success` trigger rule.

### Cage doesn't actually hold against Bash

`denied_tools` blocks `Read(tests/**)` etc., but the dev agent routinely
bypasses by `cat tests/foo.test.ts` or `node ./node_modules/.bin/vitest`.
Prompt-level imperative rules (DO NOT READ TESTS / DO NOT RUN TESTS) are
the only other defense and they're prompt-obedience, not enforcement.

**Fix shape (deferred)**: patch Archon to support script-based hooks
on `PreToolUse(Bash)`. The matcher would still be a regex against the
tool name; the new field would let us run a script that inspects the
actual `tool_input` and decides allow/deny based on command content. ~80
LOC patch in `packages/workflows/src/schemas/hooks.ts` +
`packages/providers/src/claude/provider.ts`. Discussed but not built.

### Failed-twice ticket has no graceful exit

If validate-1 and validate-2 both fail AND dev-attempt-loop hits
max_iterations without convergence, the chain cascades through skips
and the workflow completes with no PR. The ticket sits in `In Progress`
indefinitely. We don't currently surface this to a human cleanly.

**Fix shape (deferred)**: after the loop fails, add a node that posts a
Jira comment summarizing all attempts' feedback.json and applies the
`archon-needs-human-review` label.

### Concurrency limits are absent

Pipeline can run N tickets in parallel. We've observed 7 simultaneous
task-implements running OK. Beyond ~10 we'd hit Anthropic rate limits or
disk/memory. There's no Kanban WIP cap today.

**Fix shape (deferred)**: in `jira-task-done.ts`'s sweep, before
promoting candidates, count currently-running task-implements; promote
only `cap - running` of them; the rest stay in Backlog and get picked
up by the next Done's sweep. Single point of control.

### `--auto` merge requires repo setting

`gh pr merge --auto` requires `Settings → General → Pull Requests →
Allow auto-merge`. ConflictCoach doesn't have that on, so we use
synchronous `--squash --delete-branch` without `--auto`. If a PR has
real conflicts, the merge fails immediately (correct signal); if it
needs CI checks first, this would also fail (no CI on ConflictCoach
yet, so non-issue).

### Stale-base merge conflicts

When 5+ tickets are in flight in parallel, the second-to-last to merge
often hits `CHANGELOG.md` or `package-lock.json` conflicts. Per-ticket
changelog fragments help; for `package-lock.json` it's just real
contention.

`rebase-on-main` runs before dev-attempt-1 (recent change) so the dev
agent starts on current main. But the loop then runs the dev agent
multiple times against the same base — if a sibling merges DURING the
loop, the loop's commits will conflict at merge time. Manual rebase is
the current solution (we've done a handful: see git log for the
rebase-resolve-changelog union pattern in CHANGELOG / src/index.css
conflicts).

---

## Recent history

| commit | what |
|---|---|
| `4f5a801d` | own implement-fixes command, not bundled |
| `296ebc61` / `8e86bf0b` / `f384e365` | dev-attempt-loop with COMPLETE signal + until_bash |
| `b4abb860` | rebase-on-main runs BEFORE dev-attempt-1 |
| `399423c2` | imperative DO NOT READ TESTS rules on dev prompts |
| `fabd9030` | task-done JQL "labels not in" syntax fix |
| `b785ee1f` | task-done excludes archon-blocked-pending tickets |
| `a06af4f6` | merge-pr drops --auto |
| `0a82e624` | per-ticket changelog fragments + rebase-on-main (initial) |
| `92765ff5` | mutates_checkout: false on jira-router and task-done |
| `1e46b96f` | task-done workflow + jira-task-done.ts |
| `3550156b` | merge-pr guards against missing pr-info.json |
| `5962d203` | parse-synthesis bridge + ISSUE_KEY quoting + case-insensitive dirs |
| `bac5e918` | file-driven validation + per-attempt artifacts |
| `2d7fbfb2` | failed-not-terminal + DELETABLE_WORKFLOW_STATUSES |
| `a41ca8ca` | merge origin/dev (88 upstream commits) |
| `5a0bdc0c` | initial full task-tests/task-implement pipeline |
| `1e46b96f` ↪ `09c16ed6` ↪ `8e0cc709` ↪ `0ac07656` | epic-decompose, placeholders, Jira adapter |

---

## Successful merges so far (WOR-X tickets)

WOR-23, WOR-24, WOR-25, WOR-26, WOR-28, WOR-29, WOR-38, WOR-39, WOR-40,
WOR-41, WOR-42, WOR-43, WOR-63, WOR-65, WOR-29 — all merged to ConflictCoach
`main` via the pipeline (some with manual conflict resolution; most fully
autonomous). The cascade has been validated end-to-end: human transitions
one Epic to Selected for Development, the wave of children flows through
test-gen → implement → review → merge → unblock-next-wave with no human
intervention except the explicit pause-by-label mechanism.
