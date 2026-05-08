# Conflict Coach — Technical Specification & Architecture
**Version 1.0 · April 2026 · Applied Labs (aplab.ai)**

> This document is a normative implementation brief. Every contract here is binding. An AI coding agent (e.g., Claude Code) should be able to implement the v1 app from this document alone.

---

## 1. System Overview

### 1.1 Architecture at a Glance

```
┌──────────────────────────────────────────────────────────────┐
│                    Client (React SPA)                        │
│   Vite + TS + Tailwind + shadcn/ui + Convex React client    │
└────────────────┬─────────────────────────────────────────────┘
                 │  Convex reactive queries (WebSocket)
                 │  Convex mutations & actions (RPC)
                 ▼
┌──────────────────────────────────────────────────────────────┐
│                       Convex Backend                         │
│  ┌────────────┐  ┌───────────┐  ┌───────────┐  ┌─────────┐   │
│  │ Database   │  │ Queries   │  │ Mutations │  │ Actions │   │
│  │ (document) │  │ (reactive)│  │ (txn'al)  │  │ (ext    │   │
│  │            │  │           │  │           │  │  API)   │   │
│  └────────────┘  └───────────┘  └───────────┘  └────┬────┘   │
│                                                      │        │
│  ┌─────────────────────────────────────────────┐     │        │
│  │ Convex Auth (magic link + Google OAuth)     │     │        │
│  └─────────────────────────────────────────────┘     │        │
└──────────────────────────────────────────────────────┼────────┘
                                                       │
                                                       ▼
                                              ┌────────────────┐
                                              │ Anthropic API  │
                                              │ Claude Sonnet  │
                                              │ Claude Haiku   │
                                              └────────────────┘
```

### 1.2 Stack Decisions (Locked)

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Frontend | React 18 + Vite + TypeScript | Modern, fast dev loop, Convex-native bindings |
| Styling | styleCSS + shadcn/ui | Design-system-ready, accessible primitives |
| State | Convex React hooks + React Context | Reactive queries replace most state management |
| Routing | React Router v6 | Standard SPA routing |
| Backend | Convex | All-in-one: DB + functions + realtime + auth + file storage |
| Auth | Convex Auth (magic link + Google OAuth) | Integrated; Clerk is the swap-out plan if beta bugs bite |
| AI | Anthropic Claude via `@anthropic-ai/sdk` (Sonnet 4.5 + Haiku 4.5) | Best-in-class for coaching/facilitation quality |
| E2E Testing | Playwright | Covers critical path |
| Unit Testing | Vitest | Fast, Vite-native |
| Lint/Format | ESLint + Prettier | Standard |
| CI | GitHub Actions | Standard |

### 1.3 Out of Scope for v1
- RAG / vector search (transcripts fit in context; compression handles overflow)
- Self-hosted Convex (use managed cloud for v1)
- Offline / PWA mode
- Push notifications (email only, and only in v1.1)

---

## 2. Convex Function Model Primer

Convex has three function types, and correctly mapping our logic onto them is load-bearing:

- **Query** — reactive, pure read of the database. Clients auto-subscribe; results push updates. Used for: dashboard list, case detail, chat messages.
- **Mutation** — transactional write. Atomic; cannot call external APIs. Used for: create case, send message (to DB), mark phase complete.
- **Action** — non-transactional; CAN call external APIs (Claude). Runs in a separate execution context; calls mutations internally to persist results. Used for: any Claude API invocation.

### 2.1 Canonical Pattern: User Sends Message in Joint Chat

```
Client
  │  1. optimistic UI: render user's message immediately
  ▼
sendJointMessage (mutation)
  │  2. insert userMessage row with status=SENT
  │  3. schedule generateCoachResponse action
  ▼
generateCoachResponse (action)
  │  4. read context (query DB for transcript, both parties' private
  │     synthesized context, active template version)
  │  5. call Claude Sonnet with streaming
  │  6. insert coachMessage row via recordCoachMessage mutation
  │     (streaming: update a single row as tokens arrive)
  ▼
Any joint-chat query auto-updates on both clients
```

---

## 3. Data Model

All tables live in Convex. Convex tables are schemaless by default but we enforce a schema via `convex/schema.ts` (strongly recommended — gives type safety end-to-end).

### 3.1 Tables

```ts
// convex/schema.ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // --- Users (managed partly by Convex Auth) ---
  users: defineTable({
    email: v.string(),
    displayName: v.optional(v.string()),
    role: v.union(v.literal("USER"), v.literal("ADMIN")),
    createdAt: v.number(),
  }).index("by_email", ["email"]),

  // --- Cases ---
  cases: defineTable({
    schemaVersion: v.literal(1),
    status: v.union(
      v.literal("DRAFT_PRIVATE_COACHING"),   // initiator has created, invitee may or may not have joined
      v.literal("BOTH_PRIVATE_COACHING"),    // both parties in private coaching
      v.literal("READY_FOR_JOINT"),          // both marked PC complete; synthesis generated
      v.literal("JOINT_ACTIVE"),             // in joint chat
      v.literal("CLOSED_RESOLVED"),
      v.literal("CLOSED_UNRESOLVED"),
      v.literal("CLOSED_ABANDONED"),         // auto-closed after 30d inactivity
    ),
    isSolo: v.boolean(),                     // solo test mode
    category: v.string(),                    // "workplace" | "family" | "personal" | "contractual" | "other"
    templateVersionId: v.id("templateVersions"),
    initiatorUserId: v.id("users"),
    inviteeUserId: v.optional(v.id("users")),  // null until invite redeemed
    createdAt: v.number(),
    updatedAt: v.number(),
    closedAt: v.optional(v.number()),
    closureSummary: v.optional(v.string()),   // populated on resolution
  })
    .index("by_initiator", ["initiatorUserId"])
    .index("by_invitee", ["inviteeUserId"]),

  // --- Per-party state within a case ---
  partyStates: defineTable({
    caseId: v.id("cases"),
    userId: v.id("users"),
    role: v.union(v.literal("INITIATOR"), v.literal("INVITEE")),
    // Form fields
    mainTopic: v.optional(v.string()),
    description: v.optional(v.string()),
    desiredOutcome: v.optional(v.string()),
    // Phase state
    formCompletedAt: v.optional(v.number()),
    privateCoachingCompletedAt: v.optional(v.number()),
    synthesisText: v.optional(v.string()),   // generated post-private-coaching
    synthesisGeneratedAt: v.optional(v.number()),
    closureProposed: v.optional(v.boolean()),
    closureConfirmed: v.optional(v.boolean()),
  })
    .index("by_case", ["caseId"])
    .index("by_case_and_user", ["caseId", "userId"]),

  // --- Private coaching messages (per party, isolated) ---
  privateMessages: defineTable({
    caseId: v.id("cases"),
    userId: v.id("users"),                   // owner — only this user can read
    role: v.union(v.literal("USER"), v.literal("AI")),
    content: v.string(),
    status: v.union(v.literal("STREAMING"), v.literal("COMPLETE"), v.literal("ERROR")),
    tokens: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_case_and_user", ["caseId", "userId"])
    .index("by_case", ["caseId"]),           // used by server-side AI context assembly only; never exposed

  // --- Joint chat messages ---
  jointMessages: defineTable({
    caseId: v.id("cases"),
    authorType: v.union(v.literal("USER"), v.literal("COACH")),
    authorUserId: v.optional(v.id("users")), // null if authorType=COACH
    content: v.string(),
    status: v.union(v.literal("STREAMING"), v.literal("COMPLETE"), v.literal("ERROR")),
    // Metadata
    isIntervention: v.optional(v.boolean()), // coach intervention on inflammatory content
    replyToId: v.optional(v.id("jointMessages")),
    createdAt: v.number(),
  }).index("by_case", ["caseId"]),

  // --- Draft Coach sessions (private to drafter) ---
  draftSessions: defineTable({
    caseId: v.id("cases"),
    userId: v.id("users"),
    status: v.union(v.literal("ACTIVE"), v.literal("SENT"), v.literal("DISCARDED")),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
    finalDraft: v.optional(v.string()),      // the send-ready text when user confirms
  })
    .index("by_case_and_user", ["caseId", "userId"]),

  draftMessages: defineTable({
    draftSessionId: v.id("draftSessions"),
    role: v.union(v.literal("USER"), v.literal("AI")),
    content: v.string(),
    status: v.union(v.literal("STREAMING"), v.literal("COMPLETE"), v.literal("ERROR")),
    createdAt: v.number(),
  }).index("by_draft_session", ["draftSessionId"]),

  // --- Invite tokens ---
  inviteTokens: defineTable({
    caseId: v.id("cases"),
    token: v.string(),                       // 32 chars, url-safe, generated crypto-random
    status: v.union(v.literal("ACTIVE"), v.literal("CONSUMED"), v.literal("REVOKED")),
    createdAt: v.number(),
    consumedAt: v.optional(v.number()),
    consumedByUserId: v.optional(v.id("users")),
  })
    .index("by_token", ["token"])
    .index("by_case", ["caseId"]),

  // --- Templates ---
  templates: defineTable({
    category: v.string(),
    name: v.string(),
    currentVersionId: v.optional(v.id("templateVersions")),
    archivedAt: v.optional(v.number()),
    createdAt: v.number(),
    createdByUserId: v.id("users"),
  }).index("by_category", ["category"]),

  templateVersions: defineTable({
    templateId: v.id("templates"),
    version: v.number(),                     // monotonic within template
    // Immutable content once published
    globalGuidance: v.string(),
    coachInstructions: v.optional(v.string()),
    draftCoachInstructions: v.optional(v.string()),
    publishedAt: v.number(),
    publishedByUserId: v.id("users"),
    notes: v.optional(v.string()),
  }).index("by_template", ["templateId"]),

  // --- Audit log ---
  auditLog: defineTable({
    actorUserId: v.id("users"),
    action: v.string(),                      // e.g. "TEMPLATE_PUBLISHED", "CASE_CLOSED"
    targetType: v.string(),                  // e.g. "templateVersion", "case"
    targetId: v.string(),                    // id as string
    metadata: v.optional(v.any()),
    createdAt: v.number(),
  }).index("by_actor", ["actorUserId"]),
});
```

### 3.2 Key Invariants
1. `cases.templateVersionId` is set at case creation and **never changes**, even if the template is edited or archived later.
2. `privateMessages` for user A in case C are **never** returned by any query where the caller is not user A. Enforced in every query function.
3. `jointMessages` are visible only to users whose `partyStates` row exists for that case.
4. `inviteTokens.status` transitions `ACTIVE → CONSUMED` atomically within the redemption mutation. Re-redemption fails.
5. `templateVersions` rows are immutable once created. Publishing a new version means inserting a new row and updating `templates.currentVersionId`.
6. `cases.schemaVersion` is present on every case for forward migration support. v1 is always `1`.

---

## 4. Authentication & Authorization

### 4.1 Auth Provider
Use **Convex Auth** with two providers:
- Magic link (email-based one-time login link)
- Google OAuth

**Decision point (Q1 in PRD):** if Convex Auth beta bugs block us, swap to Clerk. The data model above is provider-agnostic (we keep our own `users` table; auth provider supplies the identity, we upsert on first login).

### 4.2 Identity Model
- Convex Auth manages tokens + session.
- `ctx.auth.getUserIdentity()` in every function returns the authenticated identity (or null).
- On first login, we upsert a row in our `users` table keyed by email (role defaults to `USER`).
- Promotion to `ADMIN` is a manual DB action in v1 (no self-serve admin claim).

### 4.3 Authorization Rules

Every query, mutation, and action starts with:

```ts
const identity = await ctx.auth.getUserIdentity();
if (!identity) throw new Error("UNAUTHENTICATED");
const user = await getUserByEmail(ctx, identity.email);
if (!user) throw new Error("USER_NOT_FOUND");
```

Then function-specific rules apply. Summary:

| Operation | Rule |
|-----------|------|
| Read own case | user is `initiatorUserId` OR `inviteeUserId` |
| Read own party state | user matches `partyStates.userId` |
| Read own private messages | user matches `privateMessages.userId` |
| Read joint messages | user is party to the case |
| Send joint message | user is party + case in `JOINT_ACTIVE` |
| Admin template CRUD | user.role == `ADMIN` |
| Redeem invite | authenticated + token is `ACTIVE` |

### 4.4 Invite Flow
1. Initiator creates case → mutation generates a token (`crypto.randomUUID().replace(/-/g,'') + crypto.randomUUID().replace(/-/g,'')`, trimmed to 32 chars).
2. Invite URL: `https://conflictcoach.app/invite/{token}`.
3. Invited user lands on `/invite/{token}`:
   - If logged out: prompt to register/login; token stashed in URL/localStorage until auth completes.
   - If logged in: show case summary (category, initiator's display name, main topic as stated by initiator — nothing from initiator's private coaching), then "Accept" button.
4. On accept → mutation: validate token is `ACTIVE`, set `cases.inviteeUserId`, create `partyStates` row for invitee, mark token `CONSUMED`. All in one transaction.
5. Reusing a consumed token returns an error and offers login/go-to-dashboard options.

---

## 5. Case Lifecycle State Machine

### 5.1 States & Transitions

```
                ┌─────────────────────────────┐
                │  DRAFT_PRIVATE_COACHING     │  ← created by initiator
                │  (initiator in PC)          │
                └────────┬────────────────────┘
                         │ invitee accepts invite + completes form
                         ▼
                ┌─────────────────────────────┐
                │  BOTH_PRIVATE_COACHING      │
                │  (both parties in PC)       │
                └────────┬────────────────────┘
                         │ both parties mark PC complete
                         │ + synthesis generated (atomic)
                         ▼
                ┌─────────────────────────────┐
                │     READY_FOR_JOINT         │
                └────────┬────────────────────┘
                         │ first party enters joint chat
                         ▼
                ┌─────────────────────────────┐
                │      JOINT_ACTIVE           │
                └──┬─────┬──────┬─────────────┘
                   │     │      │
          closure  │     │      │ 30d inactivity
          resolved │     │      │ (scheduled)
                   ▼     │      ▼
           CLOSED_RESOLVED│  CLOSED_ABANDONED
                         │
                         │ unilateral close
                         ▼
                  CLOSED_UNRESOLVED
```

### 5.2 Transition Rules
- Transitions are **server-enforced**. Client never sets `status` directly.
- Each transition is a dedicated mutation that validates the preconditions and updates atomically.
- Closure requires explicit confirmation:
  - Party A proposes (sets `partyStates.closureProposed = true`, stores proposed summary on case)
  - Party B confirms (sets `closureConfirmed = true`) → case moves to `CLOSED_RESOLVED`
  - Either party can reject; proposer flag clears
- `CLOSED_UNRESOLVED` requires only one party's action + a mandatory 24h cooling-off (not implemented in v1 — flagged as v1.1).
  - **v1 simplification:** unilateral close is immediate; the other party is notified via dashboard badge.
- `CLOSED_ABANDONED` is set by a scheduled job (Convex cron) that looks for `JOINT_ACTIVE` cases with no activity in 30 days.

### 5.3 Convex Scheduling
Use Convex's built-in scheduler:
- Daily cron (`convex/crons.ts`) scans for abandoned cases.
- After synthesis generation, schedule no action — the state moves to `READY_FOR_JOINT` synchronously within the mutation that generates the synthesis, unless synthesis is async (see §6.3 — it IS async, via an action, so the action re-enters and writes state on completion).

---

## 6. AI Integration

### 6.1 Provider & Models
- **Provider:** Anthropic, via `@anthropic-ai/sdk`.
- **Models:**
  - `claude-sonnet-4-5` — Private Coach, Coach, Draft Coach, Synthesis. All user-facing generation.
  - `claude-haiku-4-5-20251001` — Inflammatory content classification, cheap classification tasks.
- **API key:** stored in Convex environment variable `ANTHROPIC_API_KEY`. Never exposed to client.

### 6.2 Streaming
All user-facing AI responses stream. Implementation:
1. Action inserts a `_Messages` row with `status: "STREAMING"` and empty content.
2. Action calls Claude with `stream: true`.
3. As tokens arrive, action calls a mutation every ~50ms-worth of tokens (batched) to update the row's content.
4. Client's reactive query auto-updates the UI as the row changes.
5. On completion, final mutation sets `status: "COMPLETE"` and records total tokens.

### 6.3 The Three AI Roles — Contracts

All roles use a common prompt-assembly function:

```ts
function assemblePrompt(opts: {
  role: "PRIVATE_COACH" | "COACH" | "DRAFT_COACH" | "SYNTHESIS";
  caseId: Id<"cases">;
  actingUserId: Id<"users">;
  recentHistory: Message[];
  templateVersion?: TemplateVersion;
}): { system: string; messages: Message[] }
```

#### 6.3.1 Private Coach
- **Template applied:** NONE. Private coaching is an open, general-purpose AI conversation per the story doc §5.
- **System prompt (runtime default, hardcoded):**
  > "You are a calm, curious, non-judgmental listener helping a person articulate their perspective in an interpersonal conflict. Ask clarifying questions. Reflect what they say. Help them identify what they actually want, what they're feeling, and what the other person might be thinking. Do not take sides. Do not tell them they're right or wrong. Your only goal is to help them prepare to communicate with the other party clearly and calmly."
- **Context injected:** this party's form fields (main topic, description, desired outcome) + full prior private message history for this party + case.
- **Forbidden:** the other party's private content. This prompt is called with a context that does NOT include the other party's data. Strict isolation.

#### 6.3.2 Synthesis (one-shot, non-streaming)
- **Trigger:** both parties have marked private coaching complete.
- **System prompt:** instructs the model to output **two** independent synthesis texts, one per party, each containing:
  1. Areas of likely agreement
  2. Genuine points of disagreement
  3. Suggested communication approaches for the joint session
- **Critical instruction (verbatim in prompt):**
  > "You have access to both parties' private content for context. In your outputs, NEVER quote, closely paraphrase, or otherwise surface the other party's raw words. Synthesize themes and positions in your own words only. If you cannot make a point without quoting, omit it."
- **Output format:** strict JSON, validated server-side:
  ```json
  { "forInitiator": "...", "forInvitee": "..." }
  ```
- **Response filter (server-side enforcement):**
  - Tokenize the other party's private messages.
  - For each synthesis text, check for any substring ≥ 8 consecutive tokens matching any private message.
  - If match found: re-generate (up to 2 retries). If still matching: return a generic fallback synthesis + flag for admin review.
- **Persistence:** write to `partyStates.synthesisText` + `synthesisGeneratedAt`. Set `case.status = READY_FOR_JOINT` in same mutation.

#### 6.3.3 Coach (joint chat facilitator)
- **Template applied:** category-specific template if available, else default baseline. Baseline only establishes role, no methodology — per story doc §5.1.
- **Invoked:**
  - On every new user joint message (to decide: intervene? summarize? stay quiet?)
  - On @-mention by a party
  - On a timer (if 5+ exchanges with no Coach input)
- **Context:** joint chat history + BOTH parties' synthesis texts (NOT raw private messages — the synthesis is already privacy-scrubbed).
- **Hard rule:** Coach output must not quote or closely paraphrase content from either party's raw private messages. Enforcement: same response filter as synthesis.
- **"Should I speak?" gate (uses Haiku):** before Sonnet is called, Haiku classifies the last user message as one of: `INFLAMMATORY`, `PROGRESS`, `QUESTION_TO_COACH`, `NORMAL_EXCHANGE`. Coach only generates a message for non-`NORMAL_EXCHANGE` unless a timer fires.

#### 6.3.4 Draft Coach
- **Template applied:** category-specific template if available, else default baseline.
- **Conversation loop:** Draft Coach is a short, exploratory chat with the drafting user. It asks clarifying questions about intent, surfaces tone issues, and only generates a polished draft when the user signals readiness.
- **Readiness signal:** the action inspects each user turn; if the user message matches any of `["i'm ready", "draft it", "write the message", "looks good, write it", …]` or clicks a "Generate Draft" button that posts a canonical user message, Draft Coach responds with a structured output: `{ "draft": "...polished message..." }`.
- **Send gate:** generating the draft does NOT send it. The UI shows the draft with Send / Edit / Continue refining / Discard buttons. Only Send triggers the `sendJointMessage` mutation.
- **Privacy:** Draft Coach context includes the drafting user's joint-chat history (they're a party, they've already seen it) + their own synthesis. It does NOT include the other party's synthesis or private content. This keeps one party from probing the other's position through Draft Coach.

### 6.4 Transcript Compression
When the total token count of messages in the context window would exceed a budget (default **60k tokens for user-facing generation, 10k for classification**):
1. Take the oldest 50% of messages.
2. Call Haiku with a compression prompt: "Summarize this conversation segment in 500 tokens or fewer, preserving facts, decisions, emotional tone, and unresolved threads."
3. Replace those messages in the context with a single synthetic "SUMMARY:" message.
4. Cache the summary by content hash; reuse if the same segment is compressed again.

This is ported from the existing prototype's approach and is deliberately deterministic — no vector search, no RAG, nothing clever.

### 6.5 AI Error Handling
| Failure | Behavior |
|---------|----------|
| Rate limit (429) | Retry once with 2s backoff; if still fails, surface error + Retry button |
| Network timeout (>30s) | Mark message as ERROR, show Retry button |
| Invalid API key / 401 | Log + surface generic "Coach is unavailable" error; alert ops via audit log |
| Content filtered by Anthropic | Show generic "Coach can't respond to that" + encourage rephrase |
| Response filter rejects output (privacy leak detected) | Retry generation up to 2x; on final failure, show generic fallback + flag for review |

### 6.6 Cost Budget
- Per-case soft cap: **$2 in v1**. Tracked via token counts × Anthropic pricing.
- At cap: inflammatory classification continues (cheap); Coach responses degrade to templated boilerplate ("I'm limited right now — consider summarizing where you are and whether you've reached agreement"). Admin notified.
- Hard cap: **$10**, after which the case is marked `COST_LIMITED` and AI features are fully disabled; parties can still exchange messages manually but no Coach, Draft Coach, or synthesis.

---

## 7. API Surface (Convex Functions)

All functions live under `convex/`. Naming convention: `<domain>/<action>`.

### 7.1 Queries (reactive reads)

| Path | Input | Returns | Auth |
|------|-------|---------|------|
| `cases/list` | `{}` | `Case[]` (current user's) | authed |
| `cases/get` | `{ caseId }` | `Case \| null` | party to case |
| `cases/partyStates` | `{ caseId }` | `{ self: PartyState, otherPhaseOnly: { status, hasCompletedPC } }` | party to case |
| `privateCoaching/myMessages` | `{ caseId }` | `PrivateMessage[]` (only caller's) | party to case |
| `jointChat/messages` | `{ caseId }` | `JointMessage[]` | party to case + case not in private-only state |
| `jointChat/mySynthesis` | `{ caseId }` | `{ text: string } \| null` | party to case |
| `draftCoach/session` | `{ caseId }` | `{ session, messages } \| null` | party to case |
| `templates/list` | `{ category? }` | `Template[]` (non-archived) | authed |
| `admin/templates/listAll` | `{}` | `Template[]` incl. archived | admin |
| `admin/templateVersions/list` | `{ templateId }` | `TemplateVersion[]` | admin |

### 7.2 Mutations (transactional writes)

| Path | Input | Effect |
|------|-------|--------|
| `cases/create` | `{ category, mainTopic, description, desiredOutcome, templateId?, isSolo? }` | Creates case + initiator `partyStates` + invite token (or pre-bound invitee for solo); returns `caseId` + invite URL |
| `invites/redeem` | `{ token }` | Binds current user as invitee, creates their `partyStates` row, marks token consumed |
| `cases/updateMyForm` | `{ caseId, mainTopic, description, desiredOutcome }` | Updates caller's `partyStates` form fields |
| `privateCoaching/sendUserMessage` | `{ caseId, content }` | Inserts user message + schedules AI action |
| `privateCoaching/markComplete` | `{ caseId }` | Sets caller's `privateCoachingCompletedAt`; if both complete, schedules synthesis |
| `jointChat/sendUserMessage` | `{ caseId, content }` | Inserts user joint message (from Draft Coach Send button) + schedules Coach evaluation |
| `jointChat/proposeClosure` | `{ caseId, summary }` | Marks caller's `closureProposed`; records summary |
| `jointChat/confirmClosure` | `{ caseId }` | If other party has proposed, closes case as RESOLVED |
| `jointChat/unilateralClose` | `{ caseId, reason }` | Closes as UNRESOLVED |
| `draftCoach/startSession` | `{ caseId }` | Creates `draftSessions` row; returns id |
| `draftCoach/sendMessage` | `{ sessionId, content }` | Inserts user draft message + schedules Draft Coach action |
| `draftCoach/sendFinalDraft` | `{ sessionId }` | Reads `finalDraft`, calls `jointChat/sendUserMessage` internally, marks session `SENT` |
| `draftCoach/discardSession` | `{ sessionId }` | Marks session `DISCARDED` |
| `admin/templates/create` | `{ category, name, globalGuidance, coachInstructions?, draftCoachInstructions? }` | Creates template + initial version |
| `admin/templates/publishNewVersion` | `{ templateId, globalGuidance, … }` | Creates new templateVersion, updates template.currentVersionId |
| `admin/templates/archive` | `{ templateId }` | Sets `archivedAt`; existing cases unaffected |

### 7.3 Actions (external API calls)

| Path | Input | Effect |
|------|-------|--------|
| `privateCoaching/generateAIResponse` | `{ caseId, userId }` | Calls Claude, streams into `privateMessages` |
| `synthesis/generate` | `{ caseId }` | Calls Claude, validates output, writes synthesis for both parties, advances state |
| `jointChat/generateCoachResponse` | `{ caseId, triggerType }` | Haiku gate → optional Sonnet call → streams into `jointMessages` |
| `draftCoach/generateResponse` | `{ sessionId }` | Calls Claude, streams into `draftMessages`. If readiness detected, produces `finalDraft`. |

### 7.4 Error Codes
Normalize all thrown errors to a small set (wrap in a `ConvexError` with a shape: `{ code, message, httpStatus }`).

| Code | Meaning |
|------|---------|
| `UNAUTHENTICATED` | No valid session |
| `FORBIDDEN` | Authed but not allowed to access resource |
| `NOT_FOUND` | Resource missing |
| `CONFLICT` | State transition not allowed (e.g., send joint message when case not JOINT_ACTIVE) |
| `INVALID_INPUT` | Validation failed |
| `TOKEN_INVALID` | Invite token not active |
| `RATE_LIMITED` | Upstream rate limit hit |
| `AI_ERROR` | Upstream AI error (with subcategory in message) |
| `INTERNAL` | Unexpected server failure |

---

## 8. Real-Time Layer

### 8.1 How It Works
- Convex reactive queries ARE the real-time layer.
- Client subscribes via `useQuery` hook; Convex pushes updates on any underlying table change.
- For joint chat: both clients subscribe to `jointChat/messages`. Server mutation inserts a message → both clients receive an update.
- No separate WebSocket layer, no pub/sub, no polling.

### 8.2 Streaming Updates
When an AI action updates a streaming row ~20 times/second during generation, each update triggers a reactive push. This is fine at this scale but worth knowing. If perf becomes an issue in v1.1, batch updates to 200ms intervals.

### 8.3 Presence (Deferred to v1.1)
"Other party is typing" / "Other party is online" indicators are deferred. The story doc lists typing indicators as prototype UX but they're nice-to-have for v1.

---

## 9. Frontend Architecture

### 9.1 Structure
```
src/
  main.tsx                 // React + ConvexProvider + AuthProvider
  App.tsx                  // Routes
  routes/
    LandingPage.tsx
    LoginPage.tsx
    InviteAcceptPage.tsx
    Dashboard.tsx
    NewCasePage.tsx
    CaseDetail.tsx         // orchestrates phase-appropriate subview
    PrivateCoachingView.tsx
    ReadyForJointView.tsx  // shows synthesis, "Enter Joint Chat" CTA
    JointChatView.tsx
    ClosedCaseView.tsx
    admin/
      TemplatesListPage.tsx
      TemplateEditPage.tsx
      AuditLogPage.tsx
  components/
    chat/
      ChatWindow.tsx
      MessageBubble.tsx
      MessageInput.tsx
      StreamingIndicator.tsx
    draft/
      DraftCoachPanel.tsx
      DraftReadyCard.tsx
    layout/
      TopNav.tsx
      PartyToggle.tsx      // solo mode
    ui/                    // shadcn/ui primitives
  lib/
    convex.ts
    auth.ts
    formatting.ts
  hooks/
    useCurrentUser.ts
    useCurrentCase.ts
    useSoloActingParty.ts
```

### 9.2 Route Map
```
/                           Landing (logged out) or redirect to /dashboard
/login                      Magic link / Google OAuth
/invite/:token              Invite acceptance
/dashboard                  Case list
/cases/new                  Case creation form
/cases/:caseId              Case detail — routes internally by status
/cases/:caseId/private      Private coaching
/cases/:caseId/joint        Joint chat
/cases/:caseId/closed       Read-only closed view
/admin/templates            Admin list
/admin/templates/:id        Admin edit
/admin/audit                Admin audit log
```

### 9.3 Solo Mode Party Toggle
- A case where `isSolo == true` has a `PartyToggle` in the top nav.
- Toggle state stored in URL query param `?as=initiator|invitee` (so refresh preserves it).
- Hooks (`useActingPartyUserId`) read the toggle and pass the correct userId to queries.
- All data queries respect the toggle — the UI effectively simulates two sessions in one browser.

### 9.4 Streaming UI
- Each chat message row renders differently by `status`:
  - `STREAMING` → render content + blinking cursor; no copy button yet
  - `COMPLETE` → full render + copy button + timestamp
  - `ERROR` → error styling + Retry button
- Auto-scroll to latest message UNLESS user has scrolled up (detect via scroll position).

### 9.5 Accessibility
- `<main>`, `<nav>`, `<aside>` landmarks.
- Chat messages in `role="log"` with `aria-live="polite"` for new messages.
- All buttons have visible labels OR `aria-label`.
- Focus management: when a new phase opens (private coaching → joint chat), focus moves to the new primary heading.
- Playwright tests include a keyboard-only run of the critical path.

---

## 10. Testing Strategy

### 10.1 Playwright E2E (critical path)
Test suite lives under `e2e/`. Suites:

1. **`auth.spec.ts`**
   - Register new user via magic link (mock email capture)
   - Log out, log back in
   - Google OAuth (mocked)

2. **`solo-full-flow.spec.ts`** (highest-value test — solo mode runs the whole flow in one browser session)
   - Create solo case
   - Toggle to Initiator, do private coaching, mark complete
   - Toggle to Invitee, do private coaching, mark complete
   - Synthesis appears for both
   - Enter joint chat
   - Exchange messages with Draft Coach in the loop
   - Propose + confirm closure
   - Case shows in Closed section

3. **`invite-flow.spec.ts`**
   - Two browser contexts (two users)
   - User A creates case, copies invite link
   - User B opens link, registers, accepts
   - Both see case in their dashboards

4. **`draft-coach.spec.ts`**
   - Start a draft session
   - Iterate with Draft Coach
   - Verify that clicking "Generate Draft" does NOT send
   - Verify that only clicking "Send" posts to joint chat
   - Discard a draft, verify it doesn't appear

5. **`privacy.spec.ts`** (security test)
   - As user B, attempt to read user A's private messages via direct query (via Convex client dev mode) — must return FORBIDDEN
   - As an admin, attempt same — must return FORBIDDEN (admin has no cross-party read)
   - Inflammatory joint message test: verify Coach response does NOT contain any 8-token substring from the other party's private messages

6. **`admin-templates.spec.ts`**
   - Admin creates template, publishes version
   - Edit publishes v2; pinned case still uses v1
   - Archive template, verify it's hidden from category picker but pinned cases still work

7. **`state-machine.spec.ts`**
   - Attempt illegal transitions (send joint message when case in private coaching) — must fail CONFLICT
   - Attempt to mark PC complete twice — idempotent, no error
   - Attempt to redeem consumed token — TOKEN_INVALID

### 10.2 Unit Tests (Vitest)
- Pure helper functions: prompt assembly, transcript compression, token counting, synthesis validator
- Privacy response filter: given a set of "other party" messages and a candidate response, detect/miss correctly
- Invite token generator: uniqueness, url-safety

### 10.3 CI Pipeline
GitHub Actions workflow:
- `lint` (ESLint + Prettier check)
- `typecheck` (tsc --noEmit)
- `unit` (vitest)
- `e2e` (Playwright; uses a Convex dev deployment spun up per run with seeded admin user + mocked Claude API)

### 10.4 Mocking Claude in Tests
- E2E: use a test-mode env var `CLAUDE_MOCK=true` that makes the action call a deterministic stub responder rather than the real API. Stub returns canned responses with configurable delays to simulate streaming.
- Unit: direct mock of the SDK.

---

## 11. Deployment & Environment

### 11.1 Environments
| Env | Convex Deployment | URL | Purpose |
|-----|-------------------|-----|---------|
| local | dev (per developer) | localhost:5173 | local dev |
| staging | `conflict-coach-staging` | staging.conflictcoach.app | CI + beta testers |
| production | `conflict-coach-prod` | conflictcoach.app | Live users |

### 11.2 Environment Variables
Convex deployment:
- `ANTHROPIC_API_KEY` (per env; prod has strict budget alerts)
- `CLAUDE_MOCK` (true in test only)
- `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`
- `SITE_URL` (used in invite link generation)
- `MAGIC_LINK_EMAIL_FROM`

Client (Vite):
- `VITE_CONVEX_URL`
- `VITE_SITE_URL`

### 11.3 Cold-Start Local Dev
```
git clone <repo>
cd conflict-coach
npm install
cp .env.example .env.local
# fill in VITE_CONVEX_URL after convex dev starts
npx convex dev
npm run dev
```

One of the Launch Criteria (PRD §7.1) is that this exact sequence gets a developer to a working app. The README must match.

### 11.4 Seed Data
`convex/seed.ts` (admin-callable in dev only):
- Creates one admin user
- Creates 3 default templates: `workplace`, `family`, `personal` — each with a minimal globalGuidance

---

## 12. Security & Privacy Enforcement Checklist

This is the concrete implementation of PRD §6.

- [ ] Every query/mutation/action begins with identity check
- [ ] `privateMessages` reads enforce `userId == callerUserId`
- [ ] `jointMessages` reads enforce caller is party to the case
- [ ] No query returns fields from another user's `partyStates` beyond phase-level booleans
- [ ] Synthesis action's response filter is tested (unit test with adversarial prompts)
- [ ] Coach action's response filter is tested likewise
- [ ] AI system prompts contain explicit no-quote rule
- [ ] Admin role check is server-side every time (no client flag trust)
- [ ] Invite tokens are crypto-random (32 url-safe chars), single-use, stored as hash in DB (store raw for simplicity in v1 — acceptable since consumption is instant and token has no post-use value)
- [ ] Solo mode cases are visibly flagged in admin/audit views to prevent them being confused with real user data
- [ ] All audit-relevant admin actions write to `auditLog`
- [ ] ToS + privacy policy linked from every auth screen and case creation screen
- [ ] "Not for crisis / abuse situations" language in ToS + surfaced on case creation

---

## 13. Open Technical Questions

| # | Question | Proposed Default | Decision Path |
|---|----------|------------------|---------------|
| TQ1 | Convex Auth vs. Clerk? | Start with Convex Auth; measure bug pain in Phase 1 | Eng lead during Phase 1 |
| TQ2 | Response filter: token-substring vs. embedding-similarity? | Token substring (≥ 8 contiguous tokens) for v1. Simpler, deterministic. Add embedding similarity if false-negatives found. | Eng during Phase 2 |
| TQ3 | Do we stream synthesis generation, or one-shot? | One-shot, non-streaming. Synthesis is generated once per case at a gate; a brief "Generating your guidance…" loading state is fine. | Locked by this doc |
| TQ4 | How do we handle session resumption mid-streaming AI response if the user closes the tab? | The streaming message row stays in DB; when the tab reopens, the reactive query shows the final state. No resume logic needed. | Locked |
| TQ5 | Rate limiting at the app level (abuse protection)? | Convex has built-in per-user function rate limits. Tune during beta. | Ops during Phase 4 |
| TQ6 | Message deletion / edit? | Not in v1. Messages are immutable. Flagged for v1.1. | Locked |

---

## 14. Implementation Notes for Claude Code (One-Shot Generation Aid)

If this spec is being fed to Claude Code for a one-shot build:

1. **Start with `convex/schema.ts`** — it's the source of truth and must match §3.1 exactly.
2. **Implement functions table-by-table, not route-by-route** — each Convex file is one domain (cases.ts, privateCoaching.ts, jointChat.ts, draftCoach.ts, templates.ts, invites.ts, admin.ts, synthesis.ts).
3. **Build the state machine in a single helper module** (`convex/stateMachine.ts`) — every mutation that transitions state calls it. Don't inline state logic.
4. **Prompt assembly is a single module** (`convex/lib/prompts.ts`) — every AI role goes through it.
5. **Build the privacy response filter before either Coach or Synthesis** — both depend on it.
6. **UI: build the shared ChatWindow component first** — Private Coaching, Joint Chat, and Draft Coach all use it (with different config).
7. **Solo mode is a view-level feature, not a data-level one** — the DB doesn't care; the UI just lets one user act as either party. Build all paths single-user first; add the toggle last.
8. **Ship Playwright's `solo-full-flow.spec.ts` first** — it's the fastest end-to-end smoke test and will reveal integration bugs before user-facing polish.
9. **Do NOT build admin UI before the core flow works** — admin is P1; templates can be seeded and edited directly in Convex Dashboard during Phase 1.
10. **Commit after each section** — small, reviewable units beat one monster PR.

---

*Conflict Coach · Tech Spec v1.0 · Applied Labs · April 2026*
