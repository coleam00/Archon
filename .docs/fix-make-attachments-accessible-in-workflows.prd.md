# PRD: Making Attachments Available Inside Workflows

- **Status:** Implemented on branch `fix/make-attachments-accessible-to-bash-script-nodes-and-workflows`
- **Source issue:** [#2517](https://github.com/coleam00/Archon/issues/2517) — "(bug) make workflows attachment aware" half
- **Related issues:** [#2298](https://github.com/coleam00/Archon/issues/2298) (Slack attachment download — the upstream fix that makes `attachedFiles` actually populate), [#2274](https://github.com/coleam00/Archon/issues/2274) (Slack channel → project mapping)
- **History:** An earlier attempt bundled this with the `defaultWorkflow:` dispatch feature and was abandoned as "unrelated" scope creep (see the `feat(core): per-project default workflow dispatch` commit message). This branch is the clean, standalone reimplementation — nothing here was actually shipped before this branch.
- **Packages touched:** `@archon/workflows` (`executor.ts`), `@archon/core` (`orchestrator-agent.ts`, `orchestrator.ts`), docs
- **Known gaps:** see `.docs/fix-make-attachments-accessible-in-workflows.warn.md` — (1) a background-dispatch cleanup race on the web UI, unconditional for the `manage_run` native-tool dispatch path regardless of `interactive:`, not fixed in this branch; (2) no adapter except the web UI populates attachments at the source today (Slack/Telegram/Discord/GitHub/Gitea/GitLab all lack download support — Slack has a reportedly-unmerged PR, #2298, that needs revisiting). A fourth dispatch path (`archon-assist`'s CLI-Bash fallback) was also found and fixed — new `archon workflow run --attachments` CLI flag plus prompt-level attachment surfacing — but is not yet confirmed live.

## 1. Problem

Archon already downloads and stores files attached to an inbound chat message (`AttachedFile[]` — Slack uploads, web UI attachments) and lets the _AI_ see them: `attachedFiles` gets folded into prose in the prompt sent to Claude/Codex/Pi.

But nothing ever reached the **workflow engine**. A `bash:` or `script:` node executing as part of a triggered workflow run had no way to know a file had arrived, let alone where it was saved on disk. Any workflow that wanted to act on an uploaded file (parse a receipt, ingest a document, process an image) had no supported path to do it — the only "access" was the AI re-describing the file in words inside its own prompt, which is lossy and unusable by deterministic nodes.

## 2. Goals

- Give `bash:` and `script:` nodes a reliable, structured way to read the files attached to the message that triggered the run.
- Make this work for every dispatch path a workflow can start from that already carries attachment metadata — `/workflow run` with a file attached should populate it too, not only an eventual channel-intake feature.
- Keep the contract simple enough that a script never has to branch on "were there any attachments" — always-present, parse unconditionally.
- Zero behavior change for every existing workflow that doesn't look at it.

## 3. Non-Goals

- **Prompt-node access.** `prompt:` nodes are not given a `$ATTACHMENTS` substitution variable. They already learn about attachments from the message text passed to the AI. Adding a templated variable would mean inventing an escaping rule for arbitrary user-supplied filenames for a need nobody has asked for yet (YAGNI).
- **New node type or YAML surface.** No `attachment:` node, no new `when:`/`depends_on` semantics. This is delivery of existing run-scoped data into the existing subprocess environment bag that `bash:`/`script:` nodes already receive (managed env vars, GitHub token, etc.) — not a new workflow-language capability, so it doesn't trip the [Workflow Language Constitution](https://archon.diy/reference/workflow-language-constitution/).
- **File upload/download itself.** Whether a platform adapter successfully downloads an attachment to disk (e.g. the Slack fix in #2298) is out of scope here. This PRD is only about the leg from "already-downloaded file" to "visible inside the workflow run." **Caveat:** the web upload path's cleanup-after-request behavior interacts with this feature in a way that turned out not to be fully out of scope — see the warn doc.
- **Content injection.** Archon does not read file contents into the env var — only path/name/mimeType/size metadata. Reading the bytes is the node's job.

## 4. User Story

> As a workflow author, when a message that triggers my workflow has a file attached (uploaded via Slack, Discord, or the web UI), I want my `bash:`/`script:` node to be able to locate that file on disk and process it — without guessing a filename or scraping the AI's prose description of it.

Example: `obs_entry` (this branch's manual test workflow) reads `ARCHON_ATTACHMENTS` in its `announce` node and echoes each attachment's name and size.

## 5. Design

### 5.1 Data shape

A new exported type in `packages/workflows/src/executor.ts`:

```ts
export interface WorkflowAttachment {
  path: string; // absolute path on disk where the adapter saved the file
  name: string;
  mimeType: string;
  size: number;
}
```

This deliberately duplicates (structurally, not by import) `AttachedFile` from `@archon/core/types` — `@archon/workflows` must never depend on `@archon/core` (dependency direction is fixed by the package-layer rules in `CLAUDE.md`), so the type is redeclared and relies on structural typing: `@archon/core` passes its `AttachedFile[]` straight through and TypeScript accepts it because the shapes are assignable.

### 5.2 Plumbing

`attachments?: readonly WorkflowAttachment[]` is added to `ExecuteWorkflowOptions` (`executor.ts`) and threaded through every call site found — across two implementation passes — to originate a run from a message with attachments:

- `WorkflowDispatchOptions.attachments` (`orchestrator-agent.ts`) — the options bag `dispatchOrchestratorWorkflow` reads. Forwarded into its two **non-resume** execution branches (background dispatch via `dispatchBackgroundWorkflow`, and fresh foreground execution). Deliberately **not** forwarded on resume — see Edge Cases.
- `WorkflowRoutingContext.attachments` (`orchestrator.ts`) — the same field read by `dispatchBackgroundWorkflow` and forwarded into its `executeWorkflow` call.
- The call in `handleMessage()` that reaches `handleWorkflowRunCommand` passes `attachments: attachedFiles` — the same `AttachedFile[]` already being read to build the AI prompt. `handleWorkflowRunCommand` forwards its whole `options` bag (including `attachments`) into both of its `dispatchOrchestratorWorkflow` calls (direct-codebase and auto-selected-single-codebase branches), so no separate threading was needed there.
- `handleWorkflowInvocationResult` — the AI text-routed `/invoke-workflow` command path (parsed from the AI's own response, not a user-typed slash command) — gains a trailing `attachedFiles` parameter, threaded from `handleMessage()` through its two callers (`handleStreamMode`/`handleBatchMode`, which also gained the parameter), and passed as `attachments: attachedFiles` alongside `parseWarnings` into its own `dispatchOrchestratorWorkflow` call.
- The `manage_run` native-tool `startWorkflow()` callback (`orchestrator-agent.ts`, inside `handleMessage` — built for project-scoped Claude/Pi chats) — passes `attachments: attachedFiles` into the `WorkflowRoutingContext`-shaped object it builds for its direct `dispatchBackgroundWorkflow` call. **This turned out to be the dispatch path actually exercised by natural-language chat messages** ("start obs_entry and list attachments") during live testing — confirmed only after the `handleWorkflowInvocationResult` fix alone did not resolve the observed `0 attachments` result. Unlike the other three call sites, this one calls `dispatchBackgroundWorkflow` unconditionally and does not check `wf.interactive` — see the warn doc for the resulting race exposure.

### 5.3 Delivery into the subprocess

In `executeWorkflow` (`executor.ts`), the assembled `WorkflowConfig.envVars` gets one more key, merged **last**, unconditionally:

```ts
envVars: {
  ...fileConfig.envVars,
  ...dbEnvVars,
  ...botGitHubEnv,
  ...userGitHubEnv,
  ARCHON_ATTACHMENTS: JSON.stringify(attachments ?? []),
},
```

- **Always set.** Even with zero attachments, `ARCHON_ATTACHMENTS` is `"[]"`. This is the point: a script does `JSON.parse(process.env.ARCHON_ATTACHMENTS ?? '[]')` and never needs an `if (process.env.ARCHON_ATTACHMENTS)` presence check.
- **Merged last.** So a stale operator-set env var of the same name (e.g. accidentally defined in per-project managed env vars) can never shadow the real, run-scoped value. Covered by a regression test.
- **JSON array of `WorkflowAttachment`.** Consumers `JSON.parse` and index into `path`/`name`/`mimeType`/`size`.

Example consumption inside a `script:` node:

```ts
const attachments = JSON.parse(process.env.ARCHON_ATTACHMENTS ?? '[]');
// → [{ path: '/abs/path/note.pdf', name: 'note.pdf', mimeType: 'application/pdf', size: 1234 }]
```

### 5.4 Scope: every run reachable from an explicit trigger

This is intentionally decoupled from any future channel-intake / default-workflow-dispatch feature. Any trigger path that already carries `attachedFiles` through `/workflow run` populates `ARCHON_ATTACHMENTS`. A future dispatch feature is simply one more caller that would forward attachments the same way once it exists.

## 6. Edge Cases

| Case                                                                                               | Behavior                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No attachments on the triggering message                                                           | `ARCHON_ATTACHMENTS=[]` — always valid JSON, never absent                                                                                                                                                                                                                                                 |
| Operator has a managed env var literally named `ARCHON_ATTACHMENTS`                                | Silently overridden by the real value (merge order), not an error — documented, tested                                                                                                                                                                                                                    |
| `prompt:` node in the same workflow                                                                | Unaffected; no `$ATTACHMENTS` template variable exists, by design                                                                                                                                                                                                                                         |
| Resumed run                                                                                        | Not re-populated from the original message on resume — attachments are per-triggering-message, not persisted/replayed, and no resume call site threads `attachments` into its `executeWorkflow` options. Out of scope, matching that resume already doesn't restore AI session context either             |
| Multiple attachments                                                                               | All included as array entries, in the order the adapter attached them                                                                                                                                                                                                                                     |
| Web UI + non-interactive workflow, dispatched via `/workflow run` or AI-emitted `/invoke-workflow` | **Known race**, mitigated by `interactive: true` — see `.docs/fix-make-attachments-accessible-in-workflows.warn.md`. Confirmed live to work correctly with `interactive: true` set.                                                                                                                       |
| Web UI + `manage_run` native-tool dispatch (any project-scoped Claude/Pi chat)                     | **Known race, unconditional** — `manage_run`'s `startWorkflow()` ignores `wf.interactive` entirely and always background-dispatches. `interactive: true` provides no protection on this path. Attachments now arrive correctly when the race is won (confirmed live), but the race itself is not fixed.   |
| Adapters other than the web UI (Slack, Telegram, Discord, GitHub, Gitea, GitLab)                   | Not populated at the source — none of these adapters download attachments into `AttachedFile[]` at all (confirmed via repo-wide search). `ARCHON_ATTACHMENTS` will be `[]` regardless of this feature's correctness. Slack tracked separately at #2298, with a reportedly-unmerged PR needing revisiting. |

## 7. Security Considerations

- **New capability:** `bash:`/`script:` nodes can now see the absolute paths of files the user attached to the triggering message, and therefore read them. This is the intent of the feature, not an incidental widening — a node already has full filesystem access within its execution context, so this exposes _which_ files are relevant, not new _access_.
- **No new network calls, no secrets/token handling changes.** The credential env-var precedence chain (file < db < bot-token < per-user) is untouched; `ARCHON_ATTACHMENTS` is appended after it and cannot collide with a credential key.
- **No new filesystem access scope.** Archon reads and writes no new paths — the referenced files were already written to disk by the adapter for this run, before the workflow was ever invoked.

## 8. Testing

- `packages/workflows/src/executor.test.ts` — 3 new tests: `ARCHON_ATTACHMENTS` populated with real entries; always-set to `[]` when no attachments; not shadowed by a stale operator-set env var of the same name. Plus one existing "DB env var merge" test updated to account for the always-present key.
- `bun run type-check`, `bun run lint --max-warnings 0`, `bun run format:check`, and the generated-file drift checks all pass.
- `packages/core/src/orchestrator/*.test.ts` — unchanged pass/fail counts before and after this branch (9 pre-existing failures on `dev`, unrelated to this change — `/register-project` folder-kind detection and error-notification logging — confirmed via `git stash`).
- **Manual smoke test:** `obs_entry.yaml` (home-scoped, `~/.archon/workflows/`), with `interactive: true` added specifically to avoid the web-UI background-dispatch race documented in the warn doc. Live-tested three ways: explicit `/workflow run obs_entry` (web UI, succeeded — the intended primary path), a plain-language message that the AI routed via `manage_run` (web UI, failed until the `manage_run` fix was added, then succeeded), and the same style of message on Slack (correctly showed 0 attachments — Slack never populates `AttachedFile[]`, an unrelated, out-of-scope adapter gap).

## 9. Compatibility

- **Backward compatible.** Purely additive: a new optional field on `ExecuteWorkflowOptions`/`WorkflowDispatchOptions`/`WorkflowRoutingContext`, and one new always-present env var. No workflow that doesn't reference `ARCHON_ATTACHMENTS` changes behavior.
- **No config changes, no DB migration.**
- **Upgrade steps:** none — available immediately after upgrade for any `bash:`/`script:` node that chooses to read it.

## 10. Definition of Done

- [x] `ExecuteWorkflowOptions` accepts `attachments`
- [x] `bash:`/`script:` nodes receive `ARCHON_ATTACHMENTS` as a JSON array, always set
- [x] Applies to `/workflow run` (explicit command) and its resulting foreground/background dispatch branches
- [x] Merge order guarantees a stale operator env var can never shadow the real value
- [x] `@archon/workflows` gains no dependency on `@archon/core` (structural typing only)
- [x] Tests covering populated / empty / shadow-proof cases
- [x] Documentation updated (`reference/variables.md` — new "Attachments" section)
- [x] Manual smoke test with a real web-UI attachment — `/workflow run obs_entry` correctly showed the file's name and size
- [x] AI text-routed `/invoke-workflow` dispatch (`handleWorkflowInvocationResult`) — attachments forwarded
- [x] `manage_run` native-tool dispatch (`startWorkflow()`) — attachments forwarded; confirmed live to be the path natural-language messages actually take
- [ ] Web-UI background-dispatch cleanup race — not fixed, tracked as follow-up (see warn doc); note `manage_run` is exposed to it unconditionally, regardless of `interactive:`
- [ ] Adapter-side attachment download for Slack/Telegram/Discord/GitHub/Gitea/GitLab — none exist today; out of scope for this branch entirely, tracked in the companion issue (Slack has a reportedly-unmerged PR, #2298)

## 11. Open Questions

- Should `prompt:` nodes eventually get attachment awareness beyond prose (e.g. explicit file references for providers with native multimodal input)? Deferred — no current caller, would need its own proposal per the Workflow Language Constitution's admissibility test.
- Should the web upload cleanup race be fixed generally (defer cleanup ownership to the background run's completion), or should `manage_run` be made to respect `wf.interactive` (matching `dispatchOrchestratorWorkflow`'s existing behavior), or both? Tracked in the companion issue as follow-up work.
- Should `manage_run`'s `startWorkflow()` check `wf.interactive` and `await executeWorkflow()` directly when set, mirroring `dispatchOrchestratorWorkflow`? This would close the race for that path without touching the upload-cleanup mechanism at all. Tracked as the more targeted of the two candidate fixes in the companion issue.
