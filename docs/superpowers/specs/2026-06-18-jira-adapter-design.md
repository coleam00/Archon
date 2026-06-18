# Jira Cloud Webhook Adapter — Design

**Date:** 2026-06-18
**Status:** Approved → implemented on `feat/jira-adapter`

## Problem

Archon's Jira integration is outbound-only: bundled workflows (`archon-fix-jira-bug`, `jira-epic-slice`, …) call the Jira REST API to fetch tickets, post comments, and transition issues, but nothing *listens* to Jira. There is no way to mention `@archon` in a Jira ticket and have it act — unlike GitHub, which has a webhook adapter wired to `POST /webhooks/github`.

This adds a **Jira Cloud webhook adapter** so a comment containing `@archon …` on a Jira issue triggers Archon, routed through the orchestrator's existing AI workflow router.

## Decisions (locked during brainstorming)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Deployment | **Jira Cloud** (REST v3, basic auth, ADF) | Matches existing `JIRA_BASE_URL/JIRA_USER/JIRA_API_TOKEN` workflow config |
| Trigger | **Literal text `@archon`** (configurable via `JIRA_BOT_MENTION`) | Mirrors GitHub; no bot user provisioning needed |
| Webhook auth | **Secret in `?secret=` query param**, timing-safe compare | Jira Cloud webhooks have no HMAC; this is Atlassian's documented approach |
| Repo selection | **AI matches ticket text** | Reuses the orchestrator's existing free-text router — zero new resolver code |
| Scope (v1) | **`comment_created` only** | Matches the "mention @archon in tickets" goal |

## Key architectural insight

`dispatchOrchestratorWorkflow` (`orchestrator-agent.ts:311`) resolves the codebase and creates the worktree *before* any DAG node runs — so the repo cannot be chosen by a mid-workflow node. It must be resolved during routing.

The orchestrator's **free-text path already does this**: `handleMessage` → loads *all* codebases via `codebaseDb.listCodebases()` (`orchestrator-agent.ts:838`) → shows them to the AI → the AI emits `/invoke-workflow <workflow> --project <name>`. So the adapter hands the ticket to `handleMessage()` with **no codebase bound**, and "AI matches ticket text → picks repo" comes for free. **No changes to the orchestrator, router, command handler, or workflow engine.**

## Components

New adapter at `packages/adapters/src/forge/jira/` (first-class `forge/` namespace, like GitHub):

- **`adapter.ts`** — `JiraAdapter implements IPlatformAdapter`. Constructor `(baseUrl, user, apiToken, webhookSecret, lockManager, botMention?)`. `start()` resolves the bot's `accountId` via `GET /rest/api/3/myself` (self-loop guard); on failure, logs `jira.self_identity_failed` and falls back to an invisible marker appended to bot comments. `sendMessage` posts ADF comments (chunked via `splitIntoParagraphChunks`, retried ≤3× on transient errors). `getStreamingMode()` → `batch`; `getPlatformType()` → `jira`.
- **`types.ts`** — webhook payload + issue/comment REST shapes + minimal ADF node types.
- **`auth.ts`** — `parseJiraAllowedUsers`, `isJiraUserAuthorized` (accountId or email), `timingSafeCompareSecret`.
- **`adf.ts`** — `toAdf(text)` (paragraphs, fenced code, headings, bullet lists, inline code; degrades safely) and `adfToPlainText(body)` (handles both string and ADF-object bodies).
- **`index.ts`** — re-export; also exported from `packages/adapters/src/index.ts`.

## `handleWebhook` flow

1. Verify `?secret=` (constant-time) → mismatch drops silently.
2. Accept only `webhookEvent === 'comment_created'`.
3. Self-loop guard: skip if author `accountId` is the bot's (or marker present in fallback mode).
4. Authorization: optional `JIRA_ALLOWED_USERS` allowlist (accountId/email); unset = open.
5. Extract comment text from ADF; require `@archon` mention; strip it.
6. Slash normalization: `/workflow run X` without `--project` → rewrite to free text so the AI router picks the project.
7. Fetch issue fields + recent comments for `issueContext` / `threadContext`.
8. `db.getOrCreateConversation('jira', issueKey)` (no codebase) → `lockManager.acquireLock` → `handleMessage(this, conversationId, text, { issueContext, threadContext })`.

## Server wiring (`packages/server/src/index.ts`)

Instantiate under `JIRA_BASE_URL && JIRA_USER && JIRA_API_TOKEN && JIRA_WEBHOOK_SECRET`; push `'Jira'` to `activePlatforms`; register `POST /webhooks/jira` with the same fire-and-forget + immediate-200 pattern as GitHub.

## Config

`JIRA_BASE_URL`, `JIRA_USER`, `JIRA_API_TOKEN`, `JIRA_WEBHOOK_SECRET` (required); `JIRA_BOT_MENTION`, `JIRA_ALLOWED_USERS` (optional). Documented in `.env.example`.

## Testing

Unit tests (per mock-isolation rules — `adapter.test.ts` runs in its own `bun test` invocation): `adf.test.ts`, `auth.test.ts`, `adapter.test.ts` (webhook drop cases + valid-comment dispatch asserting no codebase + slash rewrite + marker fallback).

## Out of scope (v1 — YAGNI)

Issue-created / transition triggers · real ADF `@mention` nodes · Jira Development-panel repo resolution · project→codebase map · Jira Server/Data-Center support. All are clean extensions on this base.
