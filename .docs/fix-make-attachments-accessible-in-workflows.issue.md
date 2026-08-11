---
name: Feature Request
about: Suggest an idea for this project
title: 'Make workflows attachment-aware (bash:/script: nodes can read triggering-message files)'
labels: enhancement
assignees: ''
---

## Problem

- **What problem are you trying to solve?** Archon downloads and stores files attached to an inbound chat message (`AttachedFile[]`) and lets the AI describe them in prose, but never surfaces them to the workflow engine. A `bash:`/`script:` node running as part of a triggered workflow has no way to know a file arrived, let alone where it lives on disk.
- **Who experiences it?** Anyone building a workflow meant to act on an uploaded file — on any platform (Slack, web UI, Discord) that supports attachments.
- **How often does it come up?** Blocking — there is currently no supported path at all for a deterministic node to reach an attached file; the only "access" is the AI's own lossy prose description.

## Real Use Case

**Content-routing intake workflow.** A shared intake channel (Slack, or the web UI console)
receives arbitrary messages — sometimes plain text, sometimes a message with one or more files
attached (a screenshot, a PDF, a spreadsheet, a log dump). A single triage workflow needs to
**branch on what actually arrived**, not just on the message text:

- No attachment, text mentions "bug" / "error" → route to a bug-triage workflow.
- An attached image → run OCR / vision-model extraction first, then decide from the extracted
  content (e.g. a receipt photo → expense-intake path; a whiteboard photo → notes-summarization
  path).
- An attached `.csv`/`.xlsx` → run a deterministic `script:` node to parse rows and branch the DAG
  on their content (e.g. row count, a status column) via `when:` on the parsed output.
- An attached `.log`/`.txt` → grep for known error signatures in a `bash:` node before ever
  invoking an AI turn, keeping the deterministic-first triage path cheap and fast.

None of this is expressible today: a `bash:`/`script:` node — the only node types that can make a
structured, deterministic routing decision the engine can then act on via `when:` — has no way to
even learn a file was attached, let alone open it. The only "awareness" that exists is inside the
AI's own prompt (prose describing the file), which is fine for a human-facing chat reply but
useless as an input to `when:` conditions or downstream node logic. This is exactly the class of
workflow the [Workflow Language Constitution](https://archon.diy/reference/workflow-language-constitution/)
wants to enable: **content determines the decision, not just the message text** — but the content
has to be reachable first.

This PRD closes that gap for `bash:`/`script:` nodes specifically (see Non-Goals for why
`prompt:` nodes are intentionally left out), which is enough to build the triage/content-routing
pattern above: a `script:` node reads `ARCHON_ATTACHMENTS`, inspects/parses the file(s), and
either sets structured output for a downstream `when:` to branch on, or hands a validated path to
a later AI node for interpretation.

## Proposed Solution

Add an always-present `ARCHON_ATTACHMENTS` environment variable to every `bash:`/`script:` node subprocess, containing a JSON array of `{ path, name, mimeType, size }` for each file attached to the triggering message (`[]` when there are none). No new YAML surface, no new node type — this is delivery of existing run-scoped data into the existing subprocess env-var bag, the same mechanism used for managed per-project env vars and GitHub tokens.

Full design: `.docs/fix-make-attachments-accessible-in-workflows.prd.md`.

## User Flow

### Before (current)

```
User uploads receipt.pdf + "process this" ──▶ Archon
                                                 │
                                                 ▼
                                     AI reads file via Read tool,
                                     describes it in prose
                                                 │
                                                 ▼
                              [!] workflow node has NO way to
                                  locate/read the file itself
```

### After (proposed)

```
User uploads receipt.pdf + "process this" ──▶ Archon
                                                 │
                                                 ▼
                                  /workflow run intake-triage
                                                 │
                                                 ▼
                          [+] script: node subprocess env:
                              ARCHON_ATTACHMENTS=
                                [{"path":"/abs/receipt.pdf", ...}]
                                                 │
                                                 ▼
                              node JSON.parses it, opens the path,
                              classifies it, sets structured output
                                                 │
                                                 ▼
                              when: branches the DAG on that output
                              ──▶ expense-intake path (not bug-triage)
```

## Alternatives Considered

| Alternative                                                  | Pros                                         | Cons                                                                                                     | Why not chosen                                                                                          |
| ------------------------------------------------------------ | -------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| New `$ATTACHMENTS` template substitution for `prompt:` nodes | Symmetric with `$ARTIFACTS_DIR`/`$STATE_DIR` | Needs a filename-escaping rule for arbitrary user-supplied names; no current caller                      | YAGNI — `prompt:` nodes already see attachments in AI prose; deferred until a real need appears         |
| New `attachment:` node type                                  | Explicit, discoverable in the visual builder | New YAML surface for something that's just env-var delivery, not new engine-governed structure           | Fails the Workflow Language Constitution's admissibility test — this is data delivery, not coordination |
| Inject file _contents_ into the env var                      | One less filesystem read for the node        | Env vars have practical size limits; forces every consumer to handle inline content even for large files | Path-only keeps the contract simple and lets the node choose how to read (streaming, partial, etc.)     |

## Scope

- Package(s) likely affected: `workflows`, `core`, `cli`
- Breaking change? No
- Database changes needed? No
- New external dependencies? No

## Security Considerations

- New permissions/capabilities? Yes — `bash:`/`script:` nodes can now see the absolute paths of files attached to the triggering message (and therefore read them). This is the intent of the feature: a node already has full filesystem access within its execution context, so this exposes _which_ files are relevant, not new _access_.
- New external network calls? No
- Secrets/tokens handling? No — `ARCHON_ATTACHMENTS` is merged into the env bag after the credential precedence chain (file < db < bot-token < per-user) and cannot collide with a credential key.
- If any `Yes`, describe: see above — capability widening is scoped to path visibility only, no new filesystem or network access surface.

## ⚠️ Known Limitation: Web UI Background-Dispatch Race

Found while implementing this feature — **not fixed as part of it**, tracked here as explicit follow-up work:

The web upload endpoint (`packages/server/src/routes/api.ts`) deletes an uploaded file right after `handleMessage()` resolves. For **non-interactive workflows dispatched from the web UI**, `handleMessage()` returns before the workflow itself finishes (background dispatch is fire-and-forget — `dispatchBackgroundWorkflow` in `orchestrator.ts` only awaits worker-conversation setup and isolation resolution, not the run). A `bash:`/`script:` node that reads `ARCHON_ATTACHMENTS` in that scenario can lose a race against the cleanup and find its file already deleted.

- **Scope of the race:** web UI + a run that ends up background-dispatched + at least one attachment. Chat platforms (Slack/Telegram/Discord/GitHub) are unaffected (moot anyway — see the adapter-support limitation below); web workflows dispatched via `/workflow run` or an AI-emitted `/invoke-workflow` text command with `interactive: true` are unaffected — both go through `dispatchOrchestratorWorkflow`'s branch check, which respects `interactive` and confirmed live to run foreground.
- **Not mitigated by `interactive: true`:** the `manage_run` native tool (`orchestrator-agent.ts` — the AI starting a workflow directly via its `manage_run` tool call, available in any project-scoped Claude/Pi chat) calls `dispatchBackgroundWorkflow` unconditionally and never checks `wf.interactive`. `attachments` is forwarded on this path structurally (fixed in this branch), but the race itself remains open here regardless of `interactive:`.
- **Current mitigation:** use the explicit `/workflow run <name>` slash command, which is deterministic and never touches `manage_run` — the only fully race-free trigger today.
- **Real fix (not implemented):** either (a) defer upload-cleanup ownership from the HTTP handler's `finally` block to the background run's own completion, or (b) make `manage_run`'s `startWorkflow()` respect `wf.interactive` the same way `dispatchOrchestratorWorkflow` does.
- Full writeup: `.docs/fix-make-attachments-accessible-in-workflows.warn.md`.

## ⚠️ Known Limitation: No Adapter Except Web UI Populates Attachments

Also found while implementing — **not fixable from this branch alone**:

Only the web UI's direct file-upload endpoint (`packages/server/src/routes/api.ts`) actually
produces an `AttachedFile[]`. A repo-wide search across `packages/adapters/src` (Slack, Telegram,
Discord, GitHub, Gitea, GitLab) found zero references to `AttachedFile`/`attachedFiles` — none of
them download an attachment and populate it. So `ARCHON_ATTACHMENTS` will be `[]` for any run
triggered from those platforms no matter how complete this feature's own plumbing is, because
there's no attachment data at the source to forward.

Slack is tracked separately as [#2298](https://github.com/coleam00/Archon/issues/2298). There is
reportedly an existing PR for Slack attachment support that was never merged — **it needs to be
revisited, reopened, and landed** before this feature works end-to-end on Slack. The same applies
to every other adapter; none currently have equivalent download support, and none are tracked
here. Until adapter-side support lands per platform, treat this feature as web-UI-only in
practice.

## Fixed During Implementation: `archon-assist` Fallback → CLI Bash (4th dispatch path)

**Confirmed working live** — this was not part of the original PRD scope, but turned out to be
the actual blocker for natural-language-triggered runs:

A natural-language message that doesn't resolve via `handleWorkflowRunCommand`, the AI text-routed
`/invoke-workflow` path, or the `manage_run` native tool falls back to the bundled `archon-assist`
workflow, whose Claude agent has no `manage_run` tool available inside workflow-node execution and
instead starts a nested workflow by running `archon workflow run <name>` via its own Bash tool —
the CLI, which had zero attachment concept at all.

Fixed with three coordinated changes:

1. A new `archon workflow run <name> --attachments '<json>'` CLI flag (`cli.ts`/`workflow.ts`).
2. An `appendAttachmentsNote()` helper in `orchestrator-agent.ts` that surfaces the real attachment
   path(s) plus a ready-to-copy `--attachments` JSON value inside the message text passed to any
   workflow dispatched via `dispatchOrchestratorWorkflow` (i.e. including `archon-assist` itself) —
   necessary because workflow `command:`/`prompt:` nodes have no access to `ARCHON_ATTACHMENTS`,
   which is subprocess-only for `bash:`/`script:` nodes.
3. Updated instructions in `.archon/commands/defaults/archon-assist.md` teaching it to use the flag,
   plus a bundled-defaults regeneration (`bun run generate:bundled`).

Note: this note-appending was deliberately **not** applied to the `manage_run` native-tool dispatch
path — a `manage_run`-started workflow already receives `ARCHON_ATTACHMENTS` structurally (the
`attachments:` field forwarded into its `WorkflowRoutingContext`), so appending the same prose
there would only add noise to its `$USER_MESSAGE` without serving a proven need.

## Definition of Done

- [x] `ExecuteWorkflowOptions` accepts `attachments`
- [x] `bash:`/`script:` nodes receive `ARCHON_ATTACHMENTS` as an always-present JSON array
- [x] Applies to `/workflow run` and its resulting dispatch branches (foreground + background)
- [x] Regression tests: populated / empty / shadow-proof against a stale operator env var
- [x] Documentation updated (`reference/variables.md`)
- [x] Manual smoke test with a real web-UI attachment via explicit `/workflow run obs_entry` — correctly showed the file's name and size
- [x] Manual smoke test with a real web-UI attachment via a natural-language message routed through the `archon-assist` fallback → CLI `--attachments` path — **confirmed working live**
- [x] Attachments forwarded through the AI natural-language `/invoke-workflow` text-routing path (`handleWorkflowInvocationResult`) — a required dependency of the `archon-assist` fix above, since `archon-assist` is itself dispatched through this path
- [x] Attachments forwarded structurally through the `manage_run` native-tool dispatch path (`startWorkflow()` callback)
- [ ] Follow-up: fix the web-UI background-dispatch cleanup race generally — still open for both the background-dispatch branch of `dispatchOrchestratorWorkflow` AND, unconditionally regardless of `interactive:`, the `manage_run` path (see Known Limitation above)
- [ ] Follow-up: revisit and land Slack attachment download support (existing unmerged PR, #2298) — and equivalent support for Telegram/Discord/GitHub/Gitea/GitLab — so `ARCHON_ATTACHMENTS` isn't permanently empty on those platforms
