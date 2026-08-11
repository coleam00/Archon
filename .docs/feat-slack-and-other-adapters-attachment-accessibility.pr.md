## Summary

Describe this PR in 2-5 bullets:

- Problem: `ARCHON_ATTACHMENTS` (from the sibling branch `fix/make-attachments-accessible-in-workflows`) lets a `bash:`/`script:` workflow node see an attached file — but only the Web UI's upload endpoint ever produces an `AttachedFile[]`. Slack, Telegram, and Discord users can attach a file and Archon never knows it exists; worse, all three adapters silently drop a message outright if it carries no text, even when it carries an attachment.
- Why it matters: closes the platform gap for the attachment-in-workflows feature — "attach a file and ask Archon to process it" now works identically on Slack, Telegram, Discord, and the Web UI.
- What changed: one shared, adapter-agnostic download/validate/save pipeline (`packages/adapters/src/utils/attachment-download.ts`), consumed by a new `downloadAttachments()` method on each of `SlackAdapter`, `TelegramAdapter`, and `DiscordAdapter`; each adapter's `server/index.ts` wiring now downloads attachments before dispatch, relays a skip notice for anything that didn't make it through, forwards `attachedFiles` into `handleMessage`, and cleans up after. All three adapters' message-trigger gates were relaxed to admit an attachment-only message (no text).
- What did **not** change (scope boundary): GitHub, GitLab, and Gitea are explicitly out of scope — none expose a structured attachment field on a comment (an uploaded file becomes a markdown-embedded link in the comment body, a fundamentally different and fuzzier mechanism). No workflow-engine changes — this PR is adapter-only.

## Supersedes

**Supersedes #2419** (`fix/adapters-slack-make-attachments-available-#2298`, tracked by #2298).
That PR is Slack-only, inline (not a shared pipeline), and — confirmed by diff — does **not**
relax the text-required gate, so an attachment-only Slack message would still be silently dropped
even with it merged. This PR is a strict superset for Slack (same core safety properties: bearer
token only after a `slack.com` host check, 10 MB / 5-file caps, path sanitization, `redirect:
'manual'`) plus the text-gate fix plus Telegram and Discord. Both PRs touch `SlackAdapter`,
`SlackMessageEvent`, and the same block of `server/index.ts`, so they cannot both land as-is —
this branch is the one intended to land; #2419 should be closed once it does.

## UX Journey

### Before

```
  User                     Archon                          Workflow Node
  ────                     ──────                          ─────────────
  (Slack/Telegram/Discord)
  attaches report.pdf ──▶  event has no attachment concept
  + "process this"         at all for these 3 adapters
                            │
                            ▼
                            handleMessage(..., content) ──▶ bash:/script: node
                                                             [X] ARCHON_ATTACHMENTS
                                                                 is always []

  attaches report.pdf      content is empty/whitespace
  (NO text)             ─▶ [!] message dropped silently,
                             no response at all
```

### After

```
  User                     Archon                          Workflow Node
  ────                     ──────                          ─────────────
  (Slack/Telegram/Discord)
  attaches report.pdf ──▶  adapter.downloadAttachments()
  + "process this"         [+] AttachedFile[] via the
                              shared attachment-download
                              pipeline
                            │
                            ▼
                            handleMessage(..., content,     ──▶ bash:/script: node
                              { attachedFiles })                [+] ARCHON_ATTACHMENTS
                                                                     has the real path

  attaches report.pdf      [+] message reaches the handler
  (NO text)             ─▶     — attachment alone is enough
```

## Architecture Diagram

### Before

```
server/index.ts (per adapter: Slack, Telegram, Discord)
  onMessage handler
    │
    ├─ if (!text/content) return;  ── [X] drops attachment-only messages
    │
    └─ handleMessage(adapter, conversationId, content, { ...no attachedFiles... })
                                                              │
                                                              ▼
                                                        bash:/script: subprocess
                                                        [X] ARCHON_ATTACHMENTS: []
```

### After

```
packages/adapters/src/utils/attachment-download.ts   [+ NEW]
  downloadAttachments() / cleanupAttachments() / formatSkippedAttachmentsNotice()
    ▲            ▲            ▲
    │            │            │
SlackAdapter  TelegramAdapter  DiscordAdapter
  [~ modified]   [~ modified]    [~ modified]
  .downloadAttachments(files, conversationId)  ── per-adapter candidate mapping only
    │            │            │
    ▼            ▼            ▼
server/index.ts (per adapter)
  onMessage handler                              [~ modified, all three]
    ├─ if (!text/content && !hasAttachments) return;   ── [+] attachment-only messages admitted
    ├─ downloadAttachments() ──▶ { attachedFiles, uploadDir, skipped }
    ├─ formatSkippedAttachmentsNotice() ──▶ sendMessage() if non-null   [+ NEW]
    └─ handleMessage(adapter, conversationId, content, { ...attachedFiles })
                                                              │
                                                              ▼
                                                        bash:/script: subprocess
                                                        [+] ARCHON_ATTACHMENTS has real files
         finally: cleanupAttachments(uploadDir)   [+ NEW]
```

**Connection inventory** (list every module-to-module edge, mark changes):

| From                                                           | To                                                    | Status       | Notes                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------- | ----------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/adapters/src/utils/attachment-download.ts`           | (new module)                                          | **new**      | Shared `downloadAttachments`/`cleanupAttachments`/`formatSkippedAttachmentsNotice`, consumed by all three adapters. `@archon/core`'s `AttachedFile` type is the sole cross-package dependency.                                                                       |
| `packages/adapters/src/index.ts`                               | `attachment-download.ts`                              | **new**      | Re-exports `cleanupAttachments`, `formatSkippedAttachmentsNotice`, and the `SkippedAttachment*`/`DownloadableAttachment` types for `server/index.ts` to consume.                                                                                                     |
| `chat/slack/adapter.ts` (`SlackAdapter`)                       | `attachment-download.ts`                              | **modified** | New `downloadAttachments(files, conversationId)` method; new `botToken` field; `isTrustedSlackDownloadUrl()`; `SlackMessageEvent`/`SlackFileRef` gain a `files` field; both event handlers admit attachment-only messages.                                           |
| `chat/telegram/adapter.ts` (`TelegramAdapter`)                 | `attachment-download.ts`                              | **modified** | New `downloadAttachments({document, photo}, conversationId)` method; new `token` field; `isTrustedTelegramDownloadUrl()`; trigger broadened from `'message:text'` to `'message'`; `TelegramMessageContext` gains `document`/`photo`.                                 |
| `community/chat/discord/adapter.ts` (`DiscordAdapter`)         | `attachment-download.ts`                              | **modified** | New `downloadAttachments(message, conversationId)` method; `isTrustedDiscordDownloadUrl()`. `DiscordMessageContext` unchanged (already carried the full `Message`).                                                                                                  |
| `packages/server/src/index.ts` (Slack/Telegram/Discord wiring) | `SlackAdapter` / `TelegramAdapter` / `DiscordAdapter` | **modified** | Each `onMessage` handler now downloads attachments before dispatch, sends a skip notice, forwards `attachedFiles` into `handleMessage`, and cleans up in a `finally` after `handleMessage` resolves. Text-emptiness gates relaxed to admit attachment-only messages. |
| `@archon/adapters`                                             | `@archon/core`                                        | unchanged    | `AttachedFile` is imported (type-only) from `@archon/core`, same as the Web upload endpoint — dependency direction preserved.                                                                                                                                        |

## Label Snapshot

- Risk: `risk: low`
- Size: `size: M`
- Scope: `adapters|server`
- Module: `adapters:slack`, `adapters:telegram`, `adapters:discord`, `adapters:utils`

## Change Metadata

- Change type: `feature`
- Primary scope: `adapters`

## Linked Issue

- Closes # (see `.docs/feat-slack-and-other-adapters-attachment-accessibility.issue.md`)
- Related #2298
- Depends on # `fix/make-attachments-accessible-in-workflows` (stacked; not yet a numbered PR at time of writing — see Compatibility below for why this branch stacks on it rather than `dev`)
- Supersedes #2419 (see above)

## Validation Evidence (required)

**Now literally stacked** (not just intended to be): rebased via
`git rebase --onto fix/make-attachments-accessible-to-bash-script-nodes-and-workflows 9c08beef
feat/slack-and-other-adapters-attachment-accessibility` — zero conflicts. Full detail, including
why `--onto` (skipping a superseded duplicate commit) was needed instead of a plain rebase, is in
`.docs/feat-slack-and-other-adapters-attachment-accessibility.fail.md`.

Commands and result summary (full CONTRIBUTING.md-required suite, re-run after the rebase):

```bash
bun run check:bundled            # PASS
bun run check:bundled-skill      # PASS
bun run check:bundled-schema     # PASS
bun run check:pi-vendor-map      # PASS
bun run check:capability-matrix  # PASS
bun run type-check               # PASS — all 12 packages, 0 errors
bun run lint --max-warnings 0    # PASS — 0 warnings
bun run format:check             # PASS
bun run --filter @archon/adapters test
  # PASS — 268 + 10 + 73 + 5 + 48 = 404 tests, 0 fail (5 splits / 16 files)
  # (the 268-test run shares ONE bun test invocation across Slack, Telegram, Discord, and the
  #  new src/utils/ test file — confirms no mock.module() cross-file pollution)
bun run --filter @archon/server test   # PASS — 58 + 29 + 27 + 23 = 137 tests, 0 fail
bun run test                     # full 10-package + scripts/ suite — see below
```

- Evidence provided (test/log/trace/screenshot): command output above, full breakdown in
  `.docs/feat-slack-and-other-adapters-attachment-accessibility.fail.md`. New tests:
  `attachment-download.test.ts` (shared pipeline — success path, untrusted URL, count cap, three
  independent size-rejection paths, non-ok response, timeout, empty-dir cleanup, notice
  formatting), plus a `downloadAttachments` describe block appended to each of the three existing
  adapter test files.
- If any command is intentionally skipped, explain why: `bun run test:install` fails
  unconditionally on this Windows host (`[ERROR] Windows is not supported. Please use WSL2` — a
  platform gate, not a test result; CONTRIBUTING.md documents it as an orthogonal binary-packaging
  smoke test). The full `bun run test` across all 10 packages was run to completion (standalone
  re-runs where `--parallel`'s cross-package SIGINT-on-first-failure cut a package short); the only
  failures are pre-existing, host-specific, and in files this branch's diff against its new base
  never touches (Windows symlink-`EPERM` in `@archon/workflows`, Windows `tar` path-quoting in
  `@archon/cli`, a flaky timing test in `@archon/core` that passes clean standalone, and a
  timing-budget-sensitive fixture suite in `@archon/isolation`) — full detail and
  `git diff --stat` confirmation in the `.fail.md` report. The two packages this PR actually
  touches (`adapters`, `server`) passed 100%, exit code 0.

## Security Impact (required)

- New permissions/capabilities? (`Yes`) — `bash:`/`script:` nodes gain visibility into files
  attached via Slack/Telegram/Discord, mirroring the Web UI's existing behavior.
- New external network calls? (`Yes`) — each adapter fetches attachment bytes from its own
  platform's file host, gated by a required `isTrustedUrl` predicate evaluated before any request.
- Secrets/tokens handling changed? (`Yes`, Slack only) — the bot token is sent as `Bearer` only
  after `isTrustedSlackDownloadUrl()` confirms the URL is on a `slack.com` host; `redirect:
'manual'` prevents the header from following a redirect to an unverified host.
- File system access scope changed? (`Yes`) — new writes under
  `~/.archon/artifacts/uploads/<platform>-<conversationId>-<uuid>/`, mirroring the Web upload
  endpoint's existing directory. Both the platform-issued file id and name are `basename()`-
  stripped and reduced to `[a-zA-Z0-9._-]` before being used as path components — untrusted input
  can never escape the upload directory.
- If any `Yes`, describe risk and mitigation: see above per-item, plus the PRD's Security
  Considerations section for the full write-up, including why the Web-UI upload-cleanup race
  (documented in `fix-make-attachments-accessible-in-workflows.warn.md`) does not apply here —
  Slack, Telegram, and Discord all dispatch through the foreground/awaited path (`await
handleMessage(...)` directly in the `onMessage` handler), never the background fire-and-forget
  path that race depends on.

## Compatibility / Migration

- Backward compatible? (`Yes`) — purely additive fields and methods; a workflow or chat flow that
  never references attachments is unaffected.
- Config/env changes? (`No`)
- Database migration needed? (`No`)
- If yes, exact upgrade steps: n/a
- **Branch dependency note:** stacked on `fix/make-attachments-accessible-in-workflows` rather than
  `dev` directly, because that sibling branch is what makes `ARCHON_ATTACHMENTS` exist at all —
  without it, an adapter-downloaded attachment would only ever reach the AI's chat prompt, never a
  `bash:`/`script:` node, defeating half the point of this PR. Confirmed via analysis (not
  assumed): `dev` at the time of writing has zero references to `ARCHON_ATTACHMENTS` anywhere in
  `packages/workflows/src/executor.ts`. No dependency on `feat/unified-channelReference` — analysis
  confirmed channel identity and file-attachment payloads are orthogonal concerns with no shared
  functional code path (some file-touch overlap in `orchestrator-agent.ts`/adapter files creates
  ordinary merge-conflict risk, not a blocking dependency).

## Human Verification (required)

What was personally validated beyond CI:

- Verified scenarios: unit-level coverage of every skip reason (`too_many`, `too_large`,
  `untrusted_url`, `download_failed`, `timeout`) across the shared pipeline and each adapter's
  candidate-mapping logic; Slack's Bearer-header construction; Telegram's `getFile()` resolution
  and largest-photo selection; Discord's direct-CDN-fetch, no-auth-header path.
- Edge cases checked: a Slack file with no `url_private_download` is reported as skipped rather
  than silently dropped from the count; a `getFile()` failure on Telegram degrades to a skipped
  attachment, not a thrown error that would fail the whole message; an empty upload directory
  (every write failed) is cleaned up rather than left orphaned.
- What was not verified: live, end-to-end testing against real Slack/Telegram/Discord bot
  instances (this PR was validated at the unit level, matching the depth of coverage already
  established for these adapters' existing test suites — no live bot credentials were available
  in this environment). Flagged here rather than silently omitted.

## Side Effects / Blast Radius (required)

- Affected subsystems/workflows: every inbound message on Slack, Telegram, and Discord now runs
  an extra (usually no-op, since most messages carry no attachment) candidate-extraction step
  before dispatch. No behavior change for a message with no attachment.
- Potential unintended effects: the message-trigger relaxation means an attachment-only message
  that was previously silently ignored now produces a real response — this is the intended
  effect, not a regression, but is a visible behavior change for anyone who was relying on
  attachment-only messages being no-ops.
- Guardrails/monitoring for early detection: structured `attachment.*` log events
  (`attachment.download_completed`, `attachment.too_large`, `attachment.untrusted_url`, etc.) at
  `warn`/`info` level, consistent across all three adapters via the shared pipeline.

## Rollback Plan (required)

- Fast rollback command/path: revert this PR — every change is additive (new fields, new methods,
  relaxed gates); no data migration to unwind. Reverting also un-relaxes the message-trigger gates,
  restoring the prior (silently-drop-attachment-only-messages) behavior.
- Feature flags or config toggles (if any): none — not gated behind a flag.
- Observable failure symptoms: a malformed `ARCHON_ATTACHMENTS` value downstream would surface as
  a workflow node's `JSON.parse` failing with a clear parse-error message (established precedent
  from the sibling branch), not silently. An adapter-side download failure never throws — it
  degrades to a skip notice.

## Risks and Mitigations

- Risk: this PR and #2419 both modify `SlackAdapter`/`SlackMessageEvent`/`server/index.ts`'s Slack
  block in incompatible ways.
  - Mitigation: explicit "Supersedes #2419" above — this branch is the one intended to land;
    close #2419 once it does rather than attempting to merge both.
- Risk: the message-trigger relaxation is a real (if narrow) behavior change — an attachment-only
  message now gets a response where it previously got silence.
  - Mitigation: documented explicitly here and in the PRD as an intentional companion fix, not a
    side effect; the empty-text case is handled gracefully by the sibling branch's
    `appendAttachmentsNote()`, which degrades to just the "Attached Files" section.
- Risk: GitHub/GitLab/Gitea attachments remain unsupported.
  - Mitigation: documented as an explicit non-goal (PRD §3, issue "Scope") rather than a silent
    gap — matches the precedent set by the sibling branch's own known-limitations documentation.
