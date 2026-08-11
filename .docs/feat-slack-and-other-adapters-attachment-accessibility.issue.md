---
name: Feature Request
about: Suggest an idea for this project
title: 'Consolidating adapter behavior: attachment accessibility on Slack, Telegram, and Discord'
labels: enhancement
assignees: ''
---

## Problem

- What problem are you trying to solve? `ARCHON_ATTACHMENTS` (added in
  `fix/make-attachments-accessible-in-workflows`) lets a `bash:`/`script:` workflow node see a
  file attached to the triggering message — but only the Web UI's upload endpoint ever produces
  an `AttachedFile[]` to forward. Slack, Telegram, and Discord users can attach a file to their
  message and Archon never knows it exists.
- Who experiences it? (which platform/workflow) Anyone driving Archon from Slack, Telegram, or
  Discord who wants to hand a file to the AI or to an attachment-aware workflow.
- How often does it come up? Any workflow designed to branch on an uploaded file's content (image
  → OCR, `.csv` → parse, `.log` → grep) is currently web-UI-only in practice, even though the
  engine-side support is platform-agnostic.

## Proposed Solution

Give Slack, Telegram, and Discord the same download → `AttachedFile[]` → `attachedFiles` pipeline
the Web UI already has, consolidated into one shared implementation
(`packages/adapters/src/utils/attachment-download.ts`) rather than three separate, drifting
copies — satisfying the Rule of Three since all three adapters need it simultaneously. Also fixes
a related gap: all three adapters currently drop a message outright if it has no text, even when
it carries an attachment.

A prior, Slack-only attempt exists at `fix/adapters-slack-make-attachments-available-#2298`
(open PR #2419, tracked by #2298) — written before `ARCHON_ATTACHMENTS` existed, so it never had a
path to a workflow node. This issue treats it as motivation, not a dependency; the download logic
here is re-derived as a shared, adapter-agnostic pipeline instead of Slack-specific code.

## User Flow

### Before (current)

```
Slack/Telegram/Discord user attaches report.pdf + "process this" [!]
  → Archon dispatches to the AI with attachment metadata nowhere in reach
  → a bash:/script: node reading ARCHON_ATTACHMENTS sees []
  → an attachment-ONLY message (no text) is silently dropped, no response at all [!]
```

### After (proposed)

```
Slack/Telegram/Discord user attaches report.pdf + "process this"
  → adapter downloads the file [+], produces AttachedFile[]
  → handleMessage receives attachedFiles [+]
  → a bash:/script: node reading ARCHON_ATTACHMENTS sees the real path [+]
  → an attachment-only message (no text) now reaches the handler too [+]
```

## Alternatives Considered

| Alternative                                                                                    | Pros                                  | Cons                                                                                                                   | Why not chosen                                                                          |
| ---------------------------------------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Land PR #2419 as-is, add Telegram/Discord separately later                                     | Reuses already-reviewed Slack code    | Three independent implementations of the same safety-critical logic (caps, sanitization, trust checks) drift over time | Explicit decision: consolidate now while three adapters need it at once (Rule of Three) |
| Wait for `fix/make-attachments-accessible-in-workflows` to merge first, then start this branch | Simpler dependency graph, no stacking | Blocks this work on an unrelated PR's review timeline for no functional reason (both are additive)                     | Stacking is the standard pattern for related, sequenced work; rebasing later is cheap   |
| Include GitHub/GitLab/Gitea via markdown-link scraping now                                     | "Complete" adapter coverage in one PR | Fundamentally different mechanism (regex over comment text vs. a typed event field), much larger and fuzzier           | Explicit non-goal — documented as a known limitation instead                            |

## Scope

- Package(s) likely affected: `adapters|server`
- Breaking change? (`No`)
- Database changes needed? (`No`)
- New external dependencies? (`No`) — uses each platform's existing SDK (`@slack/bolt`, `grammy`, `discord.js`), already dependencies of `@archon/adapters`.

## Security Considerations

- New permissions/capabilities? (`Yes`) — `bash:`/`script:` nodes gain visibility into files
  attached via Slack/Telegram/Discord, mirroring what Web UI attachments already expose.
- New external network calls? (`Yes`) — each adapter fetches attachment bytes from its own
  platform's file host (Slack's `files.slack.com`, Telegram's `api.telegram.org`, Discord's CDN),
  gated by a required `isTrustedUrl` check before any request is made.
- Secrets/tokens handling? (`Yes`, Slack only) — the bot token is sent as a Bearer header only
  after the download URL is proven to be on a `slack.com` host, and `redirect: 'manual'` prevents
  it from following a redirect to an unverified host.
- If any `Yes`, describe: see the PRD's Security Considerations section for the full breakdown,
  including why the Web-UI upload-cleanup race (documented in the sibling branch's warn doc)
  does not apply here — all three adapters dispatch through the foreground/awaited path.

## Definition of Done

- [ ] Shared attachment-download pipeline implemented in `packages/adapters/src/utils/`
- [ ] Slack, Telegram, and Discord adapters each download attachments and populate `attachedFiles`
- [ ] An attachment-only message (no text) reaches the handler on all three adapters
- [ ] Tests covering the shared pipeline and each adapter's attachment logic
- [ ] Documentation: GitHub/GitLab/Gitea attachment support explicitly scoped out as a known
      limitation (not silently unsupported)
