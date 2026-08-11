## Summary

Describe this PR in 2-5 bullets:

- Problem: `bash:`/`script:` workflow nodes had no way to know a file was attached to the message that triggered the run, or where it landed on disk. The only "access" was the AI re-describing it in prose to itself — unusable by a deterministic node.
- Why it matters: unblocks content-routing workflows — e.g. an intake triage workflow that branches its DAG on what actually arrived (an image → OCR path, a `.csv` → parse-and-branch on row content via `when:`, a `.log` → deterministic grep-for-signature before any AI turn) — with an actual filesystem path instead of scraped text. See `.docs/fix-make-attachments-accessible-in-workflows.issue.md` → "Real Use Case" for the full example.
- What changed: `executeWorkflow` now merges an always-present `ARCHON_ATTACHMENTS` env var (JSON array of `{ path, name, mimeType, size }`) into every `bash:`/`script:` subprocess, sourced from the `attachedFiles` already collected for the AI prompt and threaded through `/workflow run`'s dispatch paths.
- What did **not** change (scope boundary): no new YAML surface (`prompt:` nodes get no `$ATTACHMENTS` template — Non-Goal), no content injection (path only, not bytes), and — critically — **no change to whether adapters download attachments at all**: only the web UI's upload endpoint produces `AttachedFile[]` today, so this feature is functionally inert on Slack/Telegram/Discord/GitHub/Gitea/GitLab until each adapter gets its own download support (Slack's is tracked separately as #2298, with a reportedly-unmerged PR that needs revisiting).

## UX Journey

### Before

```
  User                   Archon                       Workflow Node
  ────                   ──────                       ─────────────
  uploads receipt.pdf ─▶ saves to disk, builds
  + "process this"       AttachedFile[] for AI prompt
                          │
                          ▼
                          AI reads file via Read tool,
                          describes it in prose
                          │
                          ▼
                          dispatches /workflow run ────▶ bash:/script: node runs
                                                          [X] no way to locate the
                                                              attached file at all
```

### After

```
  User                   Archon                       Workflow Node
  ────                   ──────                       ─────────────
  uploads receipt.pdf ─▶ saves to disk, builds
  + "process this"       AttachedFile[] for AI prompt
                          │
                          ▼
                          dispatches /workflow run ────▶ executeWorkflow merges
                                                          [+] ARCHON_ATTACHMENTS=
                                                              [{"path":"/abs/receipt.pdf",...}]
                                                          │
                                                          ▼
                                                          node JSON.parses it, opens
                                                          the path, processes the file
```

## Architecture Diagram

### Before

```
handleMessage (orchestrator-agent.ts)
  │
  ├─ attachedFiles ──▶ buildFullPrompt() ──▶ AI prompt (prose only)
  │
  └─ handleWorkflowRunCommand ──▶ dispatchOrchestratorWorkflow ──▶ executeWorkflow (executor.ts)
                                                                      │
                                                                      ▼
                                                                envVars: {file, db, bot-token, per-user}
                                                                      │
                                                                      ▼
                                                                bash:/script: subprocess
                                                                [X] no attachment data
```

### After

```
handleMessage (orchestrator-agent.ts)
  │
  ├─ attachedFiles ──▶ buildFullPrompt() ──▶ AI prompt (prose, unchanged)
  │
  └─ handleWorkflowRunCommand ──▶ dispatchOrchestratorWorkflow ──▶ executeWorkflow (executor.ts)
       [~] attachments: attachedFiles             [~] attachments: options?.attachments
                                                          │  (also: WorkflowRoutingContext.attachments
                                                          │   ──▶ dispatchBackgroundWorkflow, orchestrator.ts)
                                                          ▼
                                                    envVars: {file, db, bot-token, per-user,
                                                              [+] ARCHON_ATTACHMENTS}
                                                          │
                                                          ▼
                                                    bash:/script: subprocess
                                                    [+] JSON.parse(ARCHON_ATTACHMENTS)
```

**Connection inventory** (list every module-to-module edge, mark changes):

| From                                                                               | To                                                           | Status       | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orchestrator-agent.ts` (`handleWorkflowRunCommand` call site in `handleMessage`)  | `WorkflowDispatchOptions`                                    | **modified** | now passes `attachments: attachedFiles`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `orchestrator-agent.ts` (`dispatchOrchestratorWorkflow`)                           | `executor.ts` (`executeWorkflow`)                            | **modified** | both non-resume branches (background dispatch, foreground fresh execution) now pass `attachments: options?.attachments`; resume branches unchanged (deliberately, see PRD)                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `orchestrator.ts` (`WorkflowRoutingContext`)                                       | `orchestrator.ts` (`dispatchBackgroundWorkflow`)             | **modified** | new `attachments` field forwarded into its `executeWorkflow` call                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `handleMessage`                                                                    | `handleStreamMode` / `handleBatchMode`                       | **modified** | both gain a trailing `attachedFiles` parameter, forwarded from `handleMessage`'s own context                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `handleStreamMode` / `handleBatchMode`                                             | `handleWorkflowInvocationResult`                             | **modified** | both now pass `attachedFiles` through — this is the AI natural-language `/invoke-workflow` routing path, found to be a real gap during manual testing (not just theoretical), fixed in a follow-up commit on this branch                                                                                                                                                                                                                                                                                                                                                                                      |
| `handleWorkflowInvocationResult`                                                   | `orchestrator-agent.ts` (`dispatchOrchestratorWorkflow`)     | **modified** | now passes `attachments: attachedFiles` alongside `parseWarnings`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `orchestrator-agent.ts` (`manage_run` native-tool `startWorkflow` callback)        | `orchestrator.ts` (`dispatchBackgroundWorkflow`)             | **modified** | passes `attachments: attachedFiles` structurally so a `manage_run`-started workflow's `bash:`/`script:` nodes get real `ARCHON_ATTACHMENTS`. Deliberately does **not** wrap `originalMessage` in `appendAttachmentsNote()` (removed after review) — a `manage_run`-started workflow already gets attachments structurally, so the CLI-flag hint in its own prompt text isn't needed. **Caveat:** this path calls `dispatchBackgroundWorkflow` unconditionally, ignoring `wf.interactive`, so it remains exposed to the upload-cleanup race (see warn doc) regardless of the workflow's `interactive:` setting |
| `orchestrator-agent.ts` (`dispatchOrchestratorWorkflow`'s two non-resume branches) | `appendAttachmentsNote()` (new helper)                       | **new**      | appends an "Attached Files" section + ready-to-copy `--attachments` JSON to the message text passed to `executeWorkflow`/`dispatchBackgroundWorkflow`. **Confirmed live**: this is what lets `archon-assist`'s Claude agent (dispatched through this same function) see a real file path and construct a working nested CLI call                                                                                                                                                                                                                                                                              |
| `cli.ts` / `commands/workflow.ts`                                                  | `executor.ts` (`executeWorkflow`)                            | **new**      | new `archon workflow run <name> --attachments '<json>'` flag, parsed and forwarded (fresh runs only, not `--resume`). **Confirmed live** — this is what `archon-assist`'s Bash tool call actually uses                                                                                                                                                                                                                                                                                                                                                                                                        |
| `.archon/commands/defaults/archon-assist.md`                                       | (prompt text)                                                | **modified** | instructs the agent to use `--attachments` with the JSON copied verbatim from the "Attached Files" section; bundled defaults regenerated (`bun run generate:bundled`). **Confirmed live**                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `executor.ts` (`ExecuteWorkflowOptions`)                                           | `executor.ts` (`executeWorkflow` → `WorkflowConfig.envVars`) | **new**      | `ARCHON_ATTACHMENTS` merged last, unconditionally                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `@archon/workflows`                                                                | `@archon/core`                                               | unchanged    | `WorkflowAttachment` is a structural duplicate of `AttachedFile`, not an import — dependency direction rule preserved                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## Label Snapshot

- Risk: `risk: low`
- Size: `size: S`
- Scope: `core|workflows|docs`
- Module: `workflows:executor`, `core:orchestrator`

## Change Metadata

- Change type: `feature`
- Primary scope: `workflows`

## Linked Issue

- Closes # (see `.docs/fix-make-attachments-accessible-in-workflows.issue.md`)
- Related #2517, #2298, #2274
- Depends on # (none)
- Supersedes # (none — the earlier bundled-with-dispatch attempt was abandoned before merge, not superseded)

## Rebase (2026-08-13)

Rebased onto `origin/dev` at `2379a2c9` (9 commits ahead of this branch's previous base),
picking up `feat(workflows): structural workflow signature (inputs/returns/with) (#2523)` and
`feat: add deterministic workflow dry-run (#2530)`, both of which touch
`packages/workflows/src/executor.ts` — the same file this branch modifies. Two conflicts, both
simple additive ones between upstream's new `--dry-run`/`--stubs`/`--exec-code`/`--pause-at-gates`
CLI flags and this branch's `--attachments` flag:

- `packages/cli/src/cli.ts` — merged both flag sets into `parseArgs`'s `options` and into the
  `workflow run` options object passed to `workflowRunCommand`.
- `packages/cli/src/commands/workflow.ts` — merged both import blocks (dry-run utilities +
  `WorkflowAttachment` type) and both sets of `WorkflowRunOptions` fields.

`executor.ts` itself auto-merged with no conflict. Verified the merge didn't regress upstream's
new sub-run feature by running `subrun.test.ts` (untouched by this branch) standalone against both
pristine `origin/dev` (via a disposable comparison worktree) and this branch post-rebase: 59/59
pass in both cases. Full results: `.docs/fix-make-attachments-accessible-in-workflows.fail.md`.

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

- `bun run test:install` fails immediately on this Windows host (`[ERROR] Windows is not
supported. Please use WSL2`) — a host-platform gate, not a test result. Skipped per
  CONTRIBUTING.md; orthogonal to this change (binary-packaging smoke test).
- Full `bun run test` (`bun --filter '*' --parallel test`) aborted early: Bun's `--parallel` sends
  SIGINT to every sibling package the instant one package's script exits non-zero
  (`@archon/cli`'s pre-existing `serve.test.ts` failures), so `@archon/workflows` and
  `bun test ./scripts/` never ran in that pass. Re-run standalone to completion — full per-package
  results and the exact same 3 pre-existing, Windows-host-only failures (symlink `EPERM` ×2 in
  `providers`/`workflows`, `tar` path-quoting ×2 in `cli`) documented in
  `.docs/fix-make-attachments-accessible-in-workflows.fail.md`.
- `executor.test.ts` (packages/workflows): PASS — 87/87 (3 new + 1 updated for
  `ARCHON_ATTACHMENTS`), unaffected by the rebase.
- `workflow.test.ts` / `cli.test.ts` (packages/cli) — the files this branch's rebase conflict
  resolution directly touches: PASS — 215/215 and 54/54 respectively.
- Evidence provided (test/log/trace/screenshot): command output summarized above and in full in
  `.docs/fix-make-attachments-accessible-in-workflows.fail.md`;
  `.docs/fix-make-attachments-accessible-in-workflows.warn.md` documents the one functional gap
  found during manual-test design.
- Caught by the parity check before the original commit: a pre-commit `bun run test` pass found
  `bundled-defaults.test.ts` failing — `.archon/commands/defaults/archon-assist.md` had lost the
  "Starting another workflow" section (see connection inventory above) while
  `bundled-defaults.generated.ts` still had it, a working-tree drift from an earlier edit/revert in
  this branch's history. Fixed by restoring the section to `archon-assist.md` and re-running
  `bun run generate:bundled`, confirmed byte-identical output and `bun run check:bundled` passing
  before commit. No residual risk in the merged state; noted here as evidence the generated-file
  parity guard (CLAUDE.md's `bun run generate:bundled` rule) did its job.

## Security Impact (required)

- New permissions/capabilities? (`Yes`) — `bash:`/`script:` nodes can now see the absolute paths of files attached to the triggering message. Intentional: a node already has full filesystem access in its execution context; this exposes _which_ files are relevant, not new _access_.
- New external network calls? (`No`)
- Secrets/tokens handling changed? (`No`) — `ARCHON_ATTACHMENTS` is merged after the existing credential precedence chain (file < db < bot-token < per-user) and cannot collide with a credential key.
- File system access scope changed? (`No`) — the referenced files were already written to disk by the adapter before the workflow was invoked; no new paths are read or written by this change.
- **Command injection found and fixed pre-merge:** `appendAttachmentsNote()`'s `--attachments '<json>'` hint (the `archon-assist` fallback path, Fix #3) originally interpolated `JSON.stringify(attachments)` into a naive single-quoted shell snippet. `mimeType` is not fully sanitized at the upload endpoint (`packages/server/src/routes/api.ts` splits the browser-supplied `Content-Type` on `;` but doesn't strip quote characters, so e.g. `text/plain'; touch /tmp/pwned #` survives `isAllowedUploadType`'s `startsWith('text/')` check), and the note explicitly instructs the AI to "copy it exactly as given" into its own Bash tool call — a single unescaped `'` in that JSON would have broken out of the shell literal and let injected shell content execute. Fixed with a `shellSingleQuote()` helper (POSIX `'\''`-escaping) in `orchestrator-agent.ts`, so the emitted snippet is safe to paste verbatim regardless of what characters end up in `name`/`mimeType`/`path`. Regression-tested in `orchestrator-agent.test.ts` (`appendAttachmentsNote — attachment JSON is safe to paste into a shell command`), including a test that reconstructs the shell-parsed argument from a malicious `mimeType` and asserts it round-trips to the exact original JSON with no early quote termination.
- If any `Yes`, describe risk and mitigation: see above — risk is scoped to path _visibility_, which is the feature's explicit purpose.

## Compatibility / Migration

- Backward compatible? (`Yes`) — purely additive optional fields + one new always-present env var; no workflow that doesn't reference `ARCHON_ATTACHMENTS` changes behavior.
- Config/env changes? (`No`)
- Database migration needed? (`No`)
- If yes, exact upgrade steps: n/a

## Human Verification (required)

What was personally validated beyond CI:

- Verified scenarios: `ARCHON_ATTACHMENTS` populated correctly in `executeWorkflow` unit tests (populated / empty / shadow-proof against a stale operator env var). Real end-to-end manual test performed against `obs_entry.yaml` on the web UI: `/workflow run obs_entry` with a real uploaded file correctly showed `I see 1 attachments` with the right name and size.
- Edge cases checked: resume paths deliberately do NOT forward attachments (matches "resume doesn't restore AI session context either" precedent); merge-order shadow test confirms an operator-set `ARCHON_ATTACHMENTS` env var can never win.
- Manual testing surfaced two real gaps beyond the original PRD scope, not theoretical ones: a plain-language message ("start obs_entry and list attachments") with a real attachment repeatedly showed `0 attachments`, through several iterations of fixes (the AI text-routed `/invoke-workflow` path via `handleWorkflowInvocationResult`, then the `manage_run` native-tool path), before root-causing to a **fourth** dispatch path — the bundled `archon-assist` fallback workflow starting a nested workflow via its own Bash tool calling the CLI, which had no attachment concept at all. Fixed with the CLI `--attachments` flag + `appendAttachmentsNote()` + updated `archon-assist.md` instructions (see connection inventory above). **Confirmed working live**: the exact same natural-language message, retried after this fix, correctly showed the attached file's name and size.
- What was not verified: attachments on Slack, Telegram, Discord, GitHub, Gitea, or GitLab — none of those adapters populate `AttachedFile[]` at all (see Known Limitation below), so there is nothing for this feature to forward there regardless of code correctness. Also not verified: whether the upload-cleanup race (unconditional for `manage_run`-dispatched runs) actually manifests under real-world timing/load — the live tests so far completed fast enough not to lose the race, but that is not a guarantee.

## Side Effects / Blast Radius (required)

- Affected subsystems/workflows: every `bash:`/`script:` node in every workflow now receives one additional env var (`ARCHON_ATTACHMENTS`). No behavior change for nodes that don't read it.
- Potential unintended effects: an operator with a per-project managed env var literally named `ARCHON_ATTACHMENTS` will have it silently overridden (by design, tested) rather than erroring — a workflow author relying on that operator value for something unrelated would see it disappear.
- Guardrails/monitoring for early detection: none added; this is a low-risk additive change. The one real risk found (see below) is scoped and documented, not silent.

⚠️ **Known limitation carried by this PR** (not a regression, but a gap this PR's new capability exposes): on the web UI, a **non-interactive** workflow that is background-dispatched can have its uploaded attachment deleted (by the pre-existing upload-cleanup `finally` block in `packages/server/src/routes/api.ts`) before a `bash:`/`script:` node gets to read `ARCHON_ATTACHMENTS`, because background dispatch is fire-and-forget and returns before the run finishes. Chat platforms and web workflows with `interactive: true` are unaffected — they always await the run to completion first. Mitigation used in this PR's own manual test workflow: `interactive: true`. Full analysis: `.docs/fix-make-attachments-accessible-in-workflows.warn.md`. Tracked as explicit follow-up in the linked issue, not fixed here to keep this change surgical.

⚠️ **Known limitation #2:** only the web UI's upload endpoint populates `AttachedFile[]` at all — a repo-wide search across `packages/adapters/src` (Slack, Telegram, Discord, GitHub, Gitea, GitLab) found zero references to `AttachedFile`/`attachedFiles`. None of them download an attachment and populate it, so `ARCHON_ATTACHMENTS` is `[]` for any run triggered from those platforms regardless of this PR's plumbing being correct. Slack is tracked as #2298, and there is reportedly an existing, unmerged PR for Slack attachment support that needs to be revisited and landed. Full analysis: `.docs/fix-make-attachments-accessible-in-workflows.warn.md`.

## Rollback Plan (required)

- Fast rollback command/path: revert this PR — every change is additive (new optional fields, one new env var); no data migration to unwind.
- Feature flags or config toggles (if any): none — not gated behind a flag. A workflow can be made to ignore the feature entirely simply by not reading `ARCHON_ATTACHMENTS`.
- Observable failure symptoms: a `bash:`/`script:` node's `JSON.parse(process.env.ARCHON_ATTACHMENTS ?? '[]')` throwing would indicate a malformed value — should never happen given `JSON.stringify` is always the producer, but would surface as a node failure with a clear parse-error message, not silently.

⚠️ **Known limitation #3 (fixed in this branch, confirmed live):** a fourth dispatch path exists — natural-language messages that don't resolve via `handleWorkflowRunCommand`, `handleWorkflowInvocationResult`, or `manage_run` fall back to the bundled `archon-assist` workflow, whose Claude agent (no `manage_run` tool inside workflow-node execution) previously had to start a nested workflow via its own Bash tool calling the CLI — which had zero attachment concept. Fixed with a new `archon workflow run --attachments '<json>'` CLI flag, a new `appendAttachmentsNote()` helper in `orchestrator-agent.ts` that surfaces the actual attachment path (plus a ready-to-copy `--attachments` JSON value) in any dispatched workflow's own prompt text, and updated instructions in `.archon/commands/defaults/archon-assist.md`. Compiles, type-checks, lints clean, the full test suite shows no regressions, and — being a best-effort AI-driven mechanism — was retested live end-to-end after the fix: the natural-language message that previously showed `0 attachments` now correctly shows the attached file. Full writeup: `.docs/fix-make-attachments-accessible-in-workflows.warn.md`.

## Risks and Mitigations

- Risk: web UI + non-interactive workflow + attachment can race an upload-cleanup deletion (see Side Effects and the warn doc).
  - Mitigation: documented explicitly, `interactive: true` recommended as a per-workflow workaround, general fix tracked as follow-up in the linked issue rather than bundled into this surgical change.
- Risk: the `manage_run` native-tool dispatch path (`orchestrator-agent.ts` — the AI starting a workflow via its `manage_run` tool rather than `/workflow run`) calls `dispatchBackgroundWorkflow` unconditionally, ignoring `wf.interactive`. Attachments now reach it structurally (fixed in this branch), but it is therefore _always_ exposed to the upload-cleanup race described in the warn doc, regardless of the workflow's `interactive:` setting — unlike `/workflow run` and `/invoke-workflow`, which are race-free when `interactive: true` is set.
  - Mitigation: documented in the warn doc and issue as an explicit follow-up (make `manage_run` respect `wf.interactive`); until fixed, the only fully race-free trigger is the explicit `/workflow run <name>` slash command.
- Risk: the `archon-assist` → CLI Bash fix (Known Limitation #3 above) is a best-effort, AI-driven mechanism — it depends on the model noticing the "Attached Files" section and following the `--attachments` instruction correctly, including safe shell-quoting for whatever Bash environment its tool uses. Confirmed working in live testing, but not something the engine can guarantee the way the structural `ARCHON_ATTACHMENTS` delivery is guaranteed for `bash:`/`script:` nodes.
  - Mitigation: `.archon/commands/defaults/archon-assist.md` gives explicit, copy-verbatim instructions rather than asking the model to reconstruct JSON itself, minimizing the room for it to get the flag wrong.
- Risk: attachments are functionally inert on every adapter except the web UI, because none of Slack/Telegram/Discord/GitHub/Gitea/GitLab populate `AttachedFile[]` in the first place — this PR cannot fix that from the workflow-engine side.
  - Mitigation: documented as Known Limitation #2 above and in the issue; Slack's fix is tracked separately at #2298 with a reportedly-unmerged PR that needs revisiting.
