## Summary

- **Problem:** A registered project used as an intake surface has no way to say "every
  message here always runs workflow X" — every plain message goes through the probabilistic
  AI router, or the user retypes `/workflow run <name>` on every message.
- **Why it matters:** Convention-based projects (an intake channel bound to a project) need
  deterministic routing.
- **What changed:** A new opt-in `defaultWorkflows:` table in global config maps a registered
  project to a workflow. A companion `defaultWorkflowBypass:` key configures a prefix that
  escapes a single message back to normal AI chat; a slash command escapes the same way.
  Both escapes post an in-thread notice before falling through.
- **What did NOT change (scope boundary):** No adapter code was touched. Slash commands
  route exactly as before. Projects not listed in `defaultWorkflows:` — and every conversation
  with no project bound — behave byte-for-byte as they did. No new node type, no new YAML
  surface, no DB change, no web UI surface, no attachment handling.

```yaml
# ~/.archon/config.yaml
defaultWorkflows:
  acme/support-inbox: intake-workflow # <registered project name>: <workflow name>
defaultWorkflowBypass: '* ' # optional; no built-in default
```

## UX Journey

### Before

```
  User (project bound)       Archon                          AI Router
  ─────────────────────      ──────                          ─────────
  "log this receipt" ──────▶ resolve conversation
                              build router prompt ──────────▶ picks *a* workflow
                              receive /invoke-workflow ◀───── (probabilistic)
                              run whatever was picked
  sees reply ◀─────────────  send to platform

  x  no way to pin "always intake-workflow here"
```

### After

```
  User (project bound)       Archon                          AI Router
  ─────────────────────      ──────                          ─────────
  "log this receipt" ──────▶ resolve conversation
                              *[defaultWorkflows: project -> intake-workflow]*
                              *run intake-workflow directly*  (router SKIPPED)
  sees run output ◀───────── send to platform

  "* what did I log" ──────▶ *notice posted* -> falls through -> normal AI chat
  "/workflow list"   ──────▶ *notice posted* -> deterministic command (unchanged)
  (unlisted project) ──────▶ AI router                          (unchanged)
```

## Architecture Diagram

### Before

```
   Slack ──┐
Telegram ──┤
 Discord ──┤                                    ┌─▶ command-handler  (slash)
  GitHub ──┼──▶ handleMessage() ────────────────┼─▶ paused-approval branch
     Web ──┤    (core/orchestrator/             │
     CLI ──┘     orchestrator-agent.ts)         └─▶ AI router
                        │                              │
                        ▼                              ▼
                  config-loader              handleWorkflowRunCommand
```

### After

```
   Slack ──┐
Telegram ──┤
 Discord ──┤                                    ┌─▶ command-handler  (slash)
  GitHub ──┼──▶ handleMessage() [~] ────────────┼─▶ paused-approval branch
     Web ──┤    (core/orchestrator/             │
     CLI ──┘     orchestrator-agent.ts)         ├══▶ [+] orchestrator/dispatch.ts
                        │                       │        (pure policy, no I/O)
                        │                       └─▶ AI router
                        │                              │
                        ▼                              ▼
                  config-loader [~]           handleWorkflowRunCommand
                  (+ defaultWorkflows:               (now reached by BOTH
                     passthrough)                    /workflow run AND dispatch)
                  (+ defaultWorkflowBypass:
                     passthrough)
```

Legend: `[+]` new · `[~]` modified · `══▶` new connection

**Connection inventory:**

| From                 | To                         | Status       | Notes                                                                                    |
| -------------------- | -------------------------- | ------------ | ---------------------------------------------------------------------------------------- |
| `orchestrator-agent` | `orchestrator/dispatch`    | **new**      | `resolveDispatch()` — pure policy, no I/O                                                |
| `orchestrator-agent` | `config/config-loader`     | **new**      | one extra `loadConfig()` to read `defaultWorkflows:`/`defaultWorkflowBypass:` (memoized) |
| `orchestrator-agent` | `db/codebases`             | **modified** | one extra `getCodebase()` — only when `defaultWorkflows:` is non-empty                   |
| `orchestrator-agent` | `handleWorkflowRunCommand` | **modified** | now reached by dispatch as well as `/workflow run`                                       |
| `config-loader`      | `config-types`             | unchanged    | two new optional fields on `GlobalConfig`/`MergedConfig`                                 |
| any adapter          | `handleMessage`            | unchanged    | **zero adapter changes** — this is why all six sources are covered                       |

## Label Snapshot

- Risk: `risk: low`
- Size: `size: S`
- Scope: `core|docs`
- Module: `core:orchestrator`, `core:config`

## Change Metadata

- Change type: `feature`
- Primary scope: `core`

## Linked Issue

- Closes # (see `.docs/project-to-defaultWorkflow-mapping.issue.md`)
- Related #2517 (upstream issue combining this with an unrelated attachments change — this
  PR intentionally implements only the default-workflow-assignment half)
- Depends on # —
- Supersedes # — replaces an earlier, abandoned `dispatch:`/`dispatchSigil:` implementation
  that bundled an unrelated attachments change; this branch starts clean from `dev`.

## Rebase (2026-08-13)

Rebased onto `origin/dev` at `2379a2c9` (9 commits ahead of this branch's previous base) —
**zero conflicts.** Upstream's 9 commits (notably `feat(workflows): structural workflow
signature (inputs/returns/with) (#2523)` and `feat: add deterministic workflow dry-run (#2530)`)
touch only `packages/workflows/`; this branch's changes are scoped entirely to
`packages/core/src/orchestrator/`, `packages/core/src/config/`, `packages/core/package.json`,
and docs — no file overlap, so `git rebase origin/dev` fast-forwarded cleanly. Full re-validation
below.

## Fix (2026-08-19, cont'd) — dispatched workflows were silently hiding their own parse warnings

CodeRabbit's initial walkthrough on this PR flagged a **Moderate merge risk** (not one of the
three numbered review threads above, so it never got a "confirmed addressed" reply): "Mapped
workflows can run while hiding warnings about ignored YAML configuration, making configuration
mistakes appear valid." That risk was real and had never actually been fixed.

`runDefaultWorkflow()` (`orchestrator-agent.ts`) discovers workflows via `discoverAllWorkflows()`,
which returns `WorkflowWithSource[]` entries carrying `parseWarnings?`. It mapped that array down
to bare `WorkflowDefinition`s (`available = discovered.map(w => w.workflow)`) before calling
`resolveWorkflowName()`, then called `handleWorkflowRunCommand()` with no 8th `options` argument
at all. Compare to the manual `/workflow run <name>` path, which threads
`result.workflow.parseWarnings` through to the same function (see the "mirrors parse warnings"
tests). Net effect: a workflow with keys the engine silently drops (`#2213`) would warn the user
when run via `/workflow run`, but say nothing at all when reached only through `defaultWorkflows:`
dispatch — the exact "configuration mistakes appear valid" failure mode CodeRabbit named.

Fixed: `runDefaultWorkflow` now looks up the resolved workflow's own discovery entry
(`discovered.find(w => w.workflow.name === workflow.name)`) and passes its `parseWarnings` through
to `handleWorkflowRunCommand`. New regression test in `orchestrator-agent.test.ts` ("a dispatched
default workflow surfaces its own parse warnings") — verified it fails without the fix. Suite is
now 237/237 (up from 236).

Also found and fixed while re-auditing this PR's CodeRabbit findings: the "docs: restore
project-to-defaultWorkflow-mapping .docs" commit had reintroduced the pre-fix `/\w+`
slash-command language into `prd.md`/`issue.md`/`pr.md` (this file) that CodeRabbit's Minor
finding above already got fixed in `configuration.md` — the restore evidently pulled an older
version of these three files. Corrected all three back to "starts with `/`, including a bare
`/`", matching `resolveDispatch()` and its own test.

## Rebase (2026-08-19, cont'd)

Rebased onto `dev` at `d558cd08` (5 commits ahead of this branch's previous base, `240d3a27`:
`feat(workflows): allow reusable blocks inside loop groups (#2623)` and its follow-up fixes,
all scoped to `packages/workflows/`) — **zero conflicts**, no file overlap with this branch's
`packages/core/` changes.

Full CONTRIBUTING.md validation sweep re-run post-rebase (2026-08-19, cont'd):

- `check:bundled`, `check:bundled-skill`, `check:bundled-schema`, `check:pi-vendor-map`,
  `check:capability-matrix`: **PASS**.
- `type-check`: **PASS** — all 10 packages, 0 errors.
- `lint --max-warnings 0`: **PASS** — 0 warnings.
- `format:check`: **PASS**.
- `bun run test:install` fails immediately on this Windows host — a host-platform gate, not a
  test result; skipped per CONTRIBUTING.md, as before.
- `bun run test` (root): `--parallel` SIGINT'd several packages the instant `@archon/cli`'s
  known pre-existing `serve.test.ts` tar-path failure exited non-zero — re-ran `core`,
  `adapters`, `server`, `isolation`, `providers`, and `workflows` individually to get real
  verdicts (same pattern as every prior rebase in this history):
  - `@archon/core`: **0 fail**, 526+ tests across every isolated invocation, including
    `dispatch.test.ts` (21/21) and `orchestrator-agent.test.ts` (**237/237**, up from 236 with
    this session's new regression test).
  - `@archon/adapters`, `@archon/server`, `@archon/isolation`: **0 fail**.
  - `@archon/providers`, `@archon/workflows`: 1 fail each — both the same pre-existing,
    deterministic Windows-host `EPERM` symlink failures tracked since the first rebase
    (`claude/binary-resolver.test.ts`'s `pathKind` test; `load-command-prompt.test.ts`'s
    symlinked-home-command test). Unchanged root cause, unrelated to this branch.
  - `@archon/cli`: 2 fail — the same pre-existing `tar` path-quoting bug in `serve.test.ts`.
  - `@archon/web`, `@archon/paths`, `@archon/git`: **0 fail** (ran to completion before the
    SIGINT, per the log).
- All test runs were on **Windows**, not the Linux CI platform. A CI run is still the
  authoritative gate.

## Validation Evidence (required)

Commands and result summary (re-run post-rebase, 2026-08-13):

```bash
bun run check:bundled && bun run check:bundled-skill && bun run check:bundled-schema \
  && bun run check:pi-vendor-map && bun run check:capability-matrix   # PASS — no generated-file drift
bun run type-check       # PASS — all 10 packages, 0 errors
bun run lint --max-warnings 0   # PASS — 0 warnings
bun run format:check     # PASS
bun run test              # per-package isolated runs — see fail.md for full table
```

- **`@archon/core` full suite**: 0 fail across every split, including `dispatch.test.ts`
  (18/18) and `orchestrator-agent.test.ts`.
- **Every other package**: 0 fail, **except** the same 3 pre-existing, deterministic
  Windows-host-only failures already tracked across prior sessions — symlink `EPERM` in
  `@archon/workflows`'s `load-command-prompt.test.ts` and `@archon/providers`'s `pathKind`
  test, and a `tar` path-quoting bug in `@archon/cli`'s `serve.test.ts` (×2). None are in a
  file this branch touches. Full per-package table and error text:
  `.docs/project-to-defaultWorkflow-mapping.fail.md`.
- Each package was run via its own `bun run test` script to completion, one package at a
  time — not `bun --filter '*' --parallel test`, whose `--parallel` flag SIGINTs every
  sibling package the instant one package's script exits non-zero (as it did previously with
  the `@archon/cli` `serve.test.ts` failures), which is what produced the earlier report's
  misleading exit-code-130 note and cut two packages off mid-run.
- `bun run test:install` fails immediately on this Windows host (`[ERROR] Windows is not
supported. Please use WSL2`) — a host-platform gate, not a test result. Skipped per
  CONTRIBUTING.md; orthogonal to this change (binary-packaging smoke test).
- The previously-noted `@archon/isolation` whiteout-timeout and `@archon/core`
  `ConversationLockManager` timing flake (both attributed to `--parallel` core contention, not
  code) did not reproduce in this run's isolation — consistent with that original diagnosis.
- All test runs were on **Windows**, not the Linux CI platform. A CI run is still the
  authoritative gate.

## Security Impact (required)

- New permissions/capabilities? `No` — dispatch changes _which_ workflow runs, never _what a
  workflow is permitted to do_. An intercepted message goes through the identical
  `handleWorkflowRunCommand` path as a manual `/workflow run`.
- New external network calls? `No`
- Secrets/tokens handling changed? `No`
- File system access scope changed? `No`
- If any `Yes`, describe risk and mitigation: n/a.

## Compatibility / Migration

- Backward compatible? `Yes` — with no `defaultWorkflows:` key configured, routing is
  byte-for-byte identical to today.
- Config/env changes? `Yes, additive and optional`: two new global-only keys in
  `~/.archon/config.yaml`.
- Database migration needed? `No`
- Upgrade steps: none. To adopt, add a `defaultWorkflows:` entry and restart Archon (global
  config is cached for the process lifetime).

## Human Verification (required)

What was personally validated beyond CI:

- Full `bun run validate`-equivalent gate run manually (see Validation Evidence above,
  `test:install` excluded — it refuses on Windows by design).
- Policy behavior driven exhaustively at unit level (18 tests): plain message dispatches;
  unlisted project and unbound conversation pass through untouched; bypass sigil escapes and
  is stripped, with leading whitespace on both the message and the configured value
  normalized; a bypass value with nothing after it passes the original message through
  rather than an empty prompt; slash commands bypass with a notice, including with no bypass
  configured; a bare `/` also counts as a slash command; a slash-command pattern occurring
  mid-message does NOT bypass — only a leading command does (anchored per the CodeRabbit fix
  below); project keys match case-insensitively; malformed/blank table values are ignored.
- Baseline comparison for the one non-pre-existing-looking failure (`ConversationLockManager`)
  via isolated single-file re-run, confirming it passes 9/9 outside parallel contention.
- **Live end-to-end:** validated against a real Slack workspace and a real registered
  project. Confirmed working: mapped-project dispatch to the project's default workflow; the
  bypass-sigil escape (notice posted, prefix stripped, message fell through to normal AI
  chat); the leading slash-command escape (e.g. `/workflow list`). `defaultWorkflowBypass:`
  was round-tripped through a real `~/.archon/config.yaml` on disk as part of this, not just
  the in-memory merge path. The mid-sentence case (a message like "what do you know about
  /workflow list") was live-tested BEFORE the CodeRabbit anchoring fix, when it still
  bypassed; after anchoring it correctly dispatches through the workflow instead, per the
  unit tests above — not independently re-verified live post-fix.

**⚠️ WARN — environment prerequisite hit during live testing (Windows):** dispatching to a
workflow that creates a worktree failed with `error: unable to create file ...: Filename too
long` against a project with deeply nested, long file paths (an Obsidian vault) — Windows'
260-character `MAX_PATH`, unrelated to this feature's logic. Fix: `git config core.longpaths
true`, set **globally** (`git config --global core.longpaths true`), before the first
dispatched run against such a project. See `.docs/project-to-defaultWorkflow-mapping.prd.md`
§9 and `.docs/project-to-defaultWorkflow-mapping.warn.md` for the full writeup.

**What was NOT verified:**

- Telegram, Discord, and GitHub specifically — only Slack and the structural
  single-seam argument (all six sources call `handleMessage`) cover them.

A reviewer should smoke-test one real dispatched message and one bypass escape on the
remaining platforms before relying on this in production there.

## Side Effects / Blast Radius (required)

- Affected subsystems: message intake for every platform (`handleMessage`), workflow
  dispatch (`handleWorkflowRunCommand`), global config loading.
- Potential unintended effects: `handleMessage` now performs one extra `loadConfig()` per
  non-slash message (memoized, CPU-only after the first read); a mapped project's threads
  stop reaching the AI router entirely by design — the bypass rules are the documented
  answer, and both now post an explicit notice so this is never silent.
- Guardrails/monitoring: new structured log events —
  `orchestrator.default_workflow_started` / `_completed` (info),
  `orchestrator.default_workflow_not_found` / `_ambiguous` (error).

## Rollback Plan (required)

- Fast rollback (no deploy): delete the `defaultWorkflows:` block from
  `~/.archon/config.yaml` and restart. The feature is fully inert without it.
- Full rollback: revert the feature commit(s) — self-contained, no DB migration, no
  generated files to regenerate.
- Observable failure symptoms: messages in a mapped project still reaching the AI (mapping
  not resolving); `orchestrator.default_workflow_not_found` in logs; an in-thread `⚠️`
  naming the unresolved workflow.

## Risks and Mitigations

- **Risk:** an operator adds `defaultWorkflows:` and is surprised the thread no longer talks
  back.
  - **Mitigation:** documented in the config reference and the config-file template comment;
    both bypass paths post an explicit in-thread notice.
- **Risk:** a typo in the workflow name silently disables the project.
  - **Mitigation:** an unresolvable name reports in-thread, runs nothing, and logs at
    `error`. Never a silent fall-through to the AI router.
- **Risk:** a capitalization slip in the project key silently disables the feature for that
  project.
  - **Mitigation:** keys match exactly first, then case-insensitively. Covered by test.
- **Risk:** the extra `loadConfig()` on the hot path becomes a cost if config loading ever
  gains per-call disk I/O.
  - **Mitigation:** currently free (memoized global config); would need revisiting only if
    that caching assumption changes.
