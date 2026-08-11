# PRD: Consolidating Adapter Behavior — Attachment Accessibility on Slack, Telegram, and Discord

## 1. Problem

`fix/make-attachments-accessible-in-workflows` (a sibling, not-yet-merged branch) taught the
workflow engine to forward `AttachedFile[]` into `ARCHON_ATTACHMENTS` for `bash:`/`script:` nodes.
That plumbing is adapter-agnostic — but today exactly **one** adapter ever produces an
`AttachedFile[]` in the first place: the Web UI's upload endpoint
(`packages/server/src/routes/api.ts`). A repo-wide search for `AttachedFile`/`attachedFiles`
across `packages/adapters/src` (Slack, Telegram, Discord, GitHub, Gitea, GitLab) returns zero
matches. So on every chat platform except the web, "attachments in workflows" is a feature that
exists in the engine but is unreachable — a user attaching a file on Slack or Telegram gets no
different treatment than one who typed no file at all.

This was tracked separately as [#2298](https://github.com/coleam00/Archon/issues/2298)
("Slack attachment download") with a prior, Slack-only attempt
(`fix/adapters-slack-make-attachments-available-#2298`, open as PR #2419) that predates the
`ARCHON_ATTACHMENTS` plumbing entirely — it downloads files and populates the AI's chat prompt,
but has no path to a workflow node, because that path didn't exist yet when it was written. That
branch is treated here as **motivation and prior art**, not as a dependency or a thing to extend:
its download/validate/save logic is re-derived from scratch as one shared, adapter-agnostic
pipeline instead of Slack-only bespoke code, and the message-trigger gap it never touched
(attachment-only messages with no text being silently dropped) is fixed alongside it.

## 2. Goals

- Give Slack, Telegram, and Discord the same attachment pipeline the Web UI already has:
  download → `AttachedFile[]` → `handleMessage`'s `attachedFiles` context → (via the sibling
  branch) `ARCHON_ATTACHMENTS` for `bash:`/`script:` nodes.
- Consolidate the download/validate/save mechanics — size cap, count cap, a fetch deadline, path
  sanitization, empty-directory cleanup, a user-facing skip notice — into **one** shared
  implementation instead of three near-identical, independently-drifting copies. Three adapters
  need it at once, satisfying CLAUDE.md's Rule of Three for extraction.
- Stop silently dropping a message that carries an attachment but no text — today Slack, Telegram,
  and Discord all gate the handler on non-empty text/content, so "just drop a file into the
  channel" produces no response at all on any of them.

## 3. Non-Goals

- **GitHub, GitLab, Gitea** (forge/comment-based adapters) are explicitly out of scope. None of
  them expose a structured attachment field on an inbound comment — an uploaded image or file
  becomes a markdown link embedded in the comment body (e.g.
  `![img](https://user-images.githubusercontent.com/...)`), which would require regex-scraping
  comment text: a fundamentally different, fuzzier mechanism than "read a typed field off an event
  payload." Tracked as a documented known limitation, not attempted here.
- Not re-litigating or replacing PR #2419 as a code artifact — this branch does not depend on it,
  rebase onto it, or import from it. Any overlap in approach (bearer-token trust checks, size
  caps) is convergent design, informed by having read it, not reuse.
- No new YAML surface, no workflow-engine changes — this branch is adapter-only. The engine-side
  `ARCHON_ATTACHMENTS` plumbing lives entirely in the sibling branch this one stacks on.
- Not fixing the web-upload cleanup race documented in
  `.docs/fix-make-attachments-accessible-in-workflows.warn.md` — it doesn't apply here (see
  Security Considerations: Slack/Telegram/Discord dispatch is always foreground/awaited, never
  the background path that race depends on).

## 4. User Story

> As a Slack (or Telegram, or Discord) user, I attach a CSV to my message and ask Archon to
> "process this file" — either directly in chat, or by naming a workflow that reads
> `ARCHON_ATTACHMENTS`. Today, the AI has no way to know the file exists or where it landed;
> after this change, it does, with the exact same mechanism the Web UI already uses.

## 5. Design

### 5.1 Shared pipeline

`packages/adapters/src/utils/attachment-download.ts` exports:

- `downloadAttachments(candidates, options)` — takes a platform-neutral
  `DownloadableAttachment[]` (`{ url, authorization?, name, id, mimeType?, size? }`) and returns
  `{ files: AttachedFile[], uploadDir, skipped: SkippedAttachment[] }`. Owns every safety property:
  count cap (5, mirrors the Web upload endpoint), size cap (10 MB, ditto), a per-file fetch
  timeout (30s) via `AbortController`, `redirect: 'manual'` (never let an auth header follow a
  redirect), a required `isTrustedUrl` predicate per candidate, `basename` + character-class
  sanitization on both the id and name path components, and best-effort cleanup of an empty
  upload directory if every write in it failed.
- `cleanupAttachments(uploadDir)` — best-effort recursive delete, called by each adapter's server
  wiring after `handleMessage` completes.
- `formatSkippedAttachmentsNotice(skipped)` — a shared, platform-neutral in-thread notice for
  anything that didn't make it through, so a dropped file reads as a known limit rather than
  Archon silently ignoring it.

### 5.2 Per-adapter mapping

Each adapter owns only what's actually platform-specific — turning its own event shape into
`DownloadableAttachment[]` — and calls the shared pipeline for everything else:

| Adapter  | Candidate source                                   | Auth                         | Trust check                                                                           |
| -------- | -------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------- |
| Slack    | `event.files[].url_private_download`               | `Bearer <bot token>` header  | host is `slack.com` / `*.slack.com`, HTTPS                                            |
| Telegram | `getFile(file_id)` → `file_path` → constructed URL | none (token embedded in URL) | host is `api.telegram.org` (defense-in-depth; this adapter constructs the URL itself) |
| Discord  | `message.attachments[].url` (signed CDN link)      | none                         | host is `cdn.discordapp.com` / `media.discordapp.net`                                 |

Telegram downloads only the **largest** `PhotoSize` when a photo is present (Telegram sends the
same photo pre-rendered at several resolutions); `document` and `photo` are both supported,
`video`/`audio`/`voice`/etc. are not (no current use case).

### 5.3 Message-trigger relaxation

Each adapter's `server/index.ts` wiring gated on non-empty text/content before this change —
`if (!event.text) return;` (Slack), `if (!message.content) return;` (Discord), and Telegram's
handler was registered on the `'message:text'` filter query, which never fires at all for a
document/photo sent without a caption. All three now let a message through when it carries at
least one attachment, even with empty text — the empty-string case is exactly what
`appendAttachmentsNote()` (from the sibling branch) already handles by appending only the
"Attached Files" section.

## 6. Edge Cases

- **Multiple files in one message**: first 5 processed, the rest reported as `too_many` in the
  skip notice (matches the Web upload cap).
- **A file over the size cap**: rejected before the body is buffered when the platform declares a
  size or `Content-Length` up front; a backstop check on the actual buffered size catches a
  missing or understated header.
- **An attacker-influenceable field carrying a stray quote/host** (e.g. Slack's `url_private_download`
  or Discord's `url` sourced from inbound event data): the `isTrustedUrl` check runs before any
  fetch, so a spoofed or off-platform URL is rejected without ever reaching `fetch()` — this
  matters most for Slack, where a bad URL could otherwise carry the bot token to an arbitrary host.
- **Telegram `getFile()` failure**: reported as a skipped attachment (`download_failed`), not a
  thrown error — the message still processes with whatever text it had.
- **Every download in a message fails**: the upload directory (if created) is removed rather than
  left orphaned; `attachedFiles.length > 0` gates whether `handleMessage` gets an `attachedFiles`
  key at all, so a fully-failed download behaves exactly like no attachment was ever sent.

## 7. Security Considerations

- **No new dispatch-cleanup race.** The race documented in
  `fix-make-attachments-accessible-in-workflows.warn.md` is specific to the Web UI's
  fire-and-forget `dispatchBackgroundWorkflow` path. Slack, Telegram, and Discord all dispatch
  through the **foreground, awaited** branch (`await handleMessage(...)` directly in each
  adapter's `onMessage` handler in `server/index.ts`) — cleanup runs in a `finally` block after
  that `await` settles, so there is no window where a background run outlives the cleanup.
- **Bot-token protection (Slack).** The bearer token is only ever attached after `isTrustedUrl`
  confirms the URL is actually `*.slack.com`, and `redirect: 'manual'` stops a redirect target
  from ever receiving it.
- **Path traversal.** Both the on-disk id and name components are `basename()`-stripped and
  reduced to `[a-zA-Z0-9._-]` before being joined into a path — untrusted input (a filename,
  a platform-issued id) can never escape the upload directory.
- **Discord has no bot-token exposure risk** at all here — its CDN URLs are signed, time-limited,
  and require no Authorization header — but the host check still guards against a spoofed
  attachment URL pointing off-platform.

## 8. Testing

- Unit tests for the shared pipeline (`attachment-download.test.ts`): success path, untrusted URL,
  count cap, declared-size / Content-Length / actual-body-size rejection (three independent
  checks), non-ok response, abort/timeout, empty-directory cleanup, notice formatting.
- Per-adapter tests for the new `downloadAttachments()` method: Slack (Bearer header, untrusted
  host, missing download URL), Telegram (`getFile()` resolution, largest-photo selection,
  `getFile()` failure), Discord (direct CDN fetch, untrusted host).
- Full `packages/adapters` test script (`bun run test`) passes with all three adapter test files
  and the new `src/utils/` test file sharing one `bun test` invocation — confirming no
  `mock.module()` cross-file pollution.

## 9. Compatibility

- Fully additive: one new optional `document`/`photo` field pair on `TelegramMessageContext`, one
  new optional `files` field on `SlackMessageEvent`, no changes to `DiscordMessageContext` (it
  already carried the full `Message`). No database schema changes.
- The message-trigger relaxation is a deliberate, documented behavior change: an attachment-only
  message that was previously silently dropped now reaches the handler. No existing behavior for
  a text-bearing message changes.

## 10. Definition of Done

- [ ] Shared `attachment-download.ts` pipeline implemented and tested
- [ ] Slack, Telegram, Discord each implement `downloadAttachments()` and are wired into
      `server/index.ts` (download → skip notice → `handleMessage` → cleanup)
- [ ] Attachment-only messages (no text) are no longer silently dropped on any of the three
- [ ] `bun run validate` passes
- [ ] GitHub/GitLab/Gitea explicitly documented as out of scope (issue + PR docs)

## 11. Open Questions

- None outstanding. Landing this branch as a stack on `fix/make-attachments-accessible-in-workflows`
  is a deliberate choice, not an open question — see the PR doc's dependency note.
