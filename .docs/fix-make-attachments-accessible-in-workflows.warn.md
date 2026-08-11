# WARNING: Background-dispatch cleanup race with `ARCHON_ATTACHMENTS`, plus two out-of-band fixes

## Fix #3: `archon-assist` → CLI Bash fallback (a fourth dispatch path, not originally scoped)

Live testing surfaced a **fourth** way a workflow gets started, distinct from the three covered
above (`handleWorkflowRunCommand`, `handleWorkflowInvocationResult`, `manage_run`): when a
natural-language message doesn't resolve to any of those, it falls back to the bundled
`archon-assist` workflow — a real `.archon/workflows/defaults/archon-assist.yaml` whose single
`command:` node runs Claude with "full Claude Code capabilities," including Bash. With no
`manage_run` tool available inside workflow-node execution (confirmed: that tool is wired only
into the chat layer, `orchestrator-agent.ts`, nowhere in `packages/workflows/src`), its only way
to "start obs_entry" was literally running `archon workflow run obs_entry "..."` via Bash — the
CLI, which had zero attachment concept at all (confirmed: no references to attachments anywhere
in `packages/cli/src`).

Closed with three coordinated changes:

1. `packages/cli/src/cli.ts` + `packages/cli/src/commands/workflow.ts` — a new `--attachments
'<json>'` flag on `archon workflow run`, parsed and forwarded into `executeWorkflow`'s
   `attachments` option (fresh runs only, not `--resume`, matching every other path).
2. `orchestrator-agent.ts` — a new `appendAttachmentsNote()` helper appends an "Attached Files"
   section (with a ready-to-copy `--attachments` JSON value) to the `userMessage`/`originalMessage`
   text passed into `executeWorkflow`/`dispatchBackgroundWorkflow`, for every dispatch path that
   has attachments (`dispatchOrchestratorWorkflow`'s two non-resume branches, and the `manage_run`
   `startWorkflow()` callback). This is the mechanism that gives `archon-assist`'s Claude agent
   the actual file path to work with — workflow `command:`/`prompt:` nodes have no access to
   `ARCHON_ATTACHMENTS` (subprocess-only), so without this they'd have no way to know a path
   existed at all, CLI flag or not.
3. `.archon/commands/defaults/archon-assist.md` — explicit instructions to use
   `archon workflow run <name> "<message>" --attachments '<json>'` when starting a named workflow,
   copying the JSON verbatim from the "Attached Files" section rather than reconstructing it.

**Not yet confirmed live** at the time of writing — the three fixes above compile, type-check,
lint clean, and pass the full existing test suite (no regressions), but this is a best-effort,
AI-driven mechanism (the model has to notice the instructions and follow them correctly,
including quoting the JSON safely for whatever shell its Bash tool uses) — treat it as unverified
until retested end-to-end.

## Fix #1 and #2: earlier findings

- **Status:** Known gap, not fixed in this branch (mitigated per-workflow via `interactive: true`)
- **Affects:** Web UI only, non-interactive workflows only
- **Related:** `.docs/fix-make-attachments-accessible-in-workflows.prd.md`, `.docs/fix-make-attachments-accessible-in-workflows.issue.md`

## The problem

The web upload endpoint (`packages/server/src/routes/api.ts`) saves an
uploaded file to `~/.archon/artifacts/uploads/<conversationId>/`, then deletes
it in `dispatchToOrchestrator`'s `finally` block right after `handleMessage()`
resolves. That cleanup predates this feature and was written on the
assumption that "`handleMessage()` completed" means "whatever wanted to read
the file has already read it" — true when the only reader was the AI's `Read`
tool inside that same awaited call.

This feature adds a second reader: a `bash:`/`script:` node parsing
`ARCHON_ATTACHMENTS` and opening the path inside it. For **web UI dispatches
of non-interactive workflows**, that reader can lose a race against the
cleanup, because `dispatchOrchestratorWorkflow` (`orchestrator-agent.ts`)
routes those runs through `dispatchBackgroundWorkflow` (`orchestrator.ts`),
which is explicitly fire-and-forget:

```ts
// orchestrator.ts — dispatchBackgroundWorkflow
// 8. Fire-and-forget: run workflow in background
void (async (): Promise<void> => {
  ...
  await executeWorkflow(...)
  ...
})();
```

`dispatchBackgroundWorkflow` returns once worker-conversation setup and
isolation resolution finish — **not** once the workflow itself finishes. So
`handleMessage()` returns early, `dispatchToOrchestrator`'s `finally` block
deletes the uploaded file, and the DAG (still running in the background) can
reach its `bash:`/`script:` node afterward and find the path gone.

## Correction: the `manage_run` native-tool path always races, even with `interactive: true`

Initially believed fixed by setting `interactive: true` on the test workflow; live testing on
the web UI proved otherwise. The AI's `manage_run` native tool (project-scoped Claude/Pi chats,
`orchestrator-agent.ts` — the `startWorkflow()` closure passed to `buildManageRunTool`) calls
`dispatchBackgroundWorkflow` **directly and unconditionally** — it never checks `wf.interactive`
before doing so, unlike `dispatchOrchestratorWorkflow`'s own branch logic. So a workflow started
via `manage_run` is _always_ background-dispatched, regardless of the `interactive:` flag in its
YAML. `attachments` is now forwarded on this path too (fixed in this branch), but the cleanup
race described above still applies to it unconditionally — `interactive: true` provides no
protection here, only for the `/workflow run` and `/invoke-workflow`-routed paths that actually
go through `dispatchOrchestratorWorkflow`'s branch check.

In practice this means: on the web UI, any workflow that reads `ARCHON_ATTACHMENTS` and might be
started by the AI via `manage_run` (i.e., any project-scoped chat with Claude or Pi) is exposed to
the race no matter what `interactive:` is set to. The only fully race-free way to test or rely on
this today is the explicit `/workflow run <name>` slash command, which is deterministic and never
touches `manage_run`.

## Why other paths are safe

Every other dispatch path `await`s `executeWorkflow` to completion (or to an
approval-gate pause) before `handleMessage()` returns, so cleanup can never
run early:

- Slack / Telegram / Discord / GitHub — never web, always the foreground
  branch in `dispatchOrchestratorWorkflow`. (Moot in practice anyway — see
  Warning #2 below, none of these adapters populate attachments at all.)
- Web UI, dispatched via `/workflow run` (explicit command) or an
  AI-emitted text `/invoke-workflow` command, on a workflow with
  `workflow.interactive: true` — same foreground branch as chat platforms.
  **Confirmed live** on `obs_entry` via `/workflow run obs_entry`.
- CLI `archon workflow run` — no upload mechanism exists here at all; nothing
  to race.

The race is scoped to: **web UI + a workflow reached without `interactive: true`
taking effect + at least one attachment.** As established in the correction
above, `manage_run`-initiated dispatch is _always_ in this bucket regardless of
the `interactive:` setting.

## Mitigation used for testing

`obs_entry.yaml` (the manual test workflow for this branch) has
`interactive: true` set. This reliably sidesteps the race **only** when the
run is reached via `/workflow run` or an AI-emitted `/invoke-workflow` text
command — both funnel through `dispatchOrchestratorWorkflow`'s branch check,
which respects `interactive`. Confirmed live: `/workflow run obs_entry` with
a real attachment on the web UI correctly showed `I see 1 attachments`.

It does **not** protect a run started via the `manage_run` native tool, which
ignores `interactive` entirely (see correction above) — confirmed live: a
plain-language message that made the AI invoke `manage_run` showed
`I see 0 attachments` even with `interactive: true` set and a real file
attached, both before and immediately after the `attachments`-forwarding fix
for that path (the forwarding fix closes the "attachments never arrive" gap,
but the race risk on this specific path remains open).

It is **not** a general fix for the underlying race either way: any workflow
that reads `ARCHON_ATTACHMENTS` and might be dispatched via `manage_run`
carries the race risk unconditionally; the only fully race-free trigger today
is the explicit `/workflow run <name>` slash command.

## WARNING #2: Only the web UI populates attachments today — not Slack, not any other adapter

Everything in this branch delivers `AttachedFile[]` _once it exists_. Whether it exists at
all depends entirely on the platform adapter, and today **only the web UI's direct file-upload
endpoint** (`packages/server/src/routes/api.ts`) actually produces one. A repo-wide search
for `AttachedFile`/`attachedFiles` across `packages/adapters/src` — Slack, Telegram, Discord,
GitHub, Gitea, GitLab — returns zero matches. None of them download an attachment and populate
`AttachedFile[]`, so `ARCHON_ATTACHMENTS` will always be `[]` for a run triggered from any of
those platforms, regardless of everything else fixed in this branch (the `interactive: true`
mitigation, the `handleWorkflowInvocationResult` threading fix, etc.) — there is simply no
attachment data at the source to forward.

Slack specifically is tracked as [#2298](https://github.com/coleam00/Archon/issues/2298)
("Slack attachment download — the upstream fix that makes `attachedFiles` actually populate"),
referenced in the PRD as a related-but-out-of-scope issue. **There is reportedly an existing PR
for Slack attachment support that needs to be revisited and reopened** — it was not merged, and
without it this feature is functionally inert on Slack no matter what runs on the Archon side.
The same applies to every other adapter until each gets its own equivalent download-and-populate
implementation; none currently exist and none are tracked here.

**Practical takeaway:** treat "attachments in workflows" as web-UI-only until adapter-side
download support lands per platform. Testing or demoing this feature on Slack (or any chat/forge
adapter) will show `0 attachments` even with a real file attached, and that is expected —
correctly reflecting that no file ever reached Archon's storage in the first place, not a bug in
this branch's delivery mechanism.

## What a real fix looks like (not implemented here)

Two independent fixes, either of which would close the remaining exposure:

1. Deferring cleanup ownership from the HTTP handler's `finally` block to the
   background run's own completion — e.g. `dispatchBackgroundWorkflow` takes
   the `{ files, uploadDir }` cleanup payload and unlinks it itself once its
   internal `executeWorkflow` call settles, instead of `dispatchToOrchestrator`
   doing it unconditionally.
2. Making the `manage_run` tool's `startWorkflow()` callback respect
   `wf.interactive` the same way `dispatchOrchestratorWorkflow` does — i.e.
   `await executeWorkflow(...)` directly instead of unconditionally calling
   `dispatchBackgroundWorkflow` when the target workflow declares
   `interactive: true`.

Both left out of this branch to keep the change surgical; tracked as
follow-up work in the issue doc.
