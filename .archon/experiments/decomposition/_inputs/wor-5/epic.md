```markdown
# Conflict Coach — Product Requirements Document
**Version 1.0 · April 2026 · Applied Labs (aplab.ai)**

---

## 1. Overview

### 1.1 Problem
Most interpersonal conflicts go unresolved — not from lack of goodwill, but because the moment parties try to talk, defensiveness and miscommunication hijack the conversation. Professional mediation works but is expensive (hundreds of dollars per hour), scheduled days out, and socially awkward to initiate. The result: people avoid the conversation, let resentment compound, or explode at the worst possible moment.

### 1.2 Solution
**Conflict Coach** is a web-based AI mediation tool that guides two parties through a structured, private, psychologically safe process to surface their real concerns, understand each other, and reach workable resolutions — without a human coach in the room.

The product sits between two people: it coaches each of them privately, synthesizes insights without leaking one party's words to the other, then facilitates a joint conversation in which a neutral AI mediator keeps things productive and on track. A private Draft Coach helps each party craft messages before sending, ensuring nothing inflammatory hits the joint chat.

### 1.3 Goals for v1
1. Enable two real people to complete an end-to-end mediation with zero developer intervention.
2. Enforce absolute privacy: neither party ever sees the other's raw private content.
3. Ship a web app that a solo developer can run end-to-end locally in test mode.
4. Prove the Draft Coach interaction model (AI-guided, human-approved, never auto-sent).
5. Make AI behavior fully template-driven — no hardcoded prompts, all categories tunable by admins.

### 1.4 Non-Goals for v1
- Billing and subscriptions
- Organization / team accounts, multi-tenant RBAC
- Legal mediation workflows (e-signature, binding agreements)
- Native mobile apps (web-responsive only)
- Analytics / outcome dashboards
- Telegram or alternative channels (web-only for v1)
- Multi-party conflicts (3+ parties); v1 is strictly 2-party
- Voice or video mediation
- RAG / semantic retrieval (revisit in v1.1+ if transcripts grow past context window)

---

## 2. Users & Personas

### 2.1 Primary Persona — "The Initiator" (Alex)
- **Who:** Adult in a stuck interpersonal conflict (coworker dispute, cofounder friction, family disagreement, roommate issue, contractual dispute with a freelancer, etc.)
- **Context:** Has tried to address it directly and either can't start the conversation or had it go badly. Not ready to pay for a mediator; wants a private, low-stakes way to make progress.
- **Tech comfort:** Can use a web app; expects modern UX (magic-link login, mobile-responsive web).
- **Motivation:** Wants resolution, not escalation. Wants to feel heard and to understand the other side.
- **Success:** Walks away with a concrete, mutually agreed next step and the feeling of having been fair.

### 2.2 Secondary Persona — "The Invited Party" (Jordan)
- **Who:** The other party in the conflict, invited via link.
- **Context:** May be skeptical at first ("why are we using an AI for this?"). Needs the tool to feel neutral and safe, not like Alex's tool.
- **Motivation:** Wants to be understood, not steamrolled. Needs to feel that the AI isn't taking sides.
- **Success:** Feels the process was fair and their perspective was heard in its own right.

### 2.3 Internal Persona — "The Admin" (Riley, at Applied Labs)
- **Who:** Product / operations person at Applied Labs managing AI prompt templates.
- **Motivation:** Tune the coaching quality per category (workplace, family, etc.) without shipping new code.
- **Success:** Can edit and version templates, see audit history, and publish changes safely (existing cases pinned to old versions continue unaffected).

---

## 3. User Stories & Acceptance Criteria

User stories are prioritized **P0** (must ship), **P1** (should ship), **P2** (nice to have / can follow in v1.1).

### 3.1 Authentication & Account (P0)

**US-01 — Account creation**
*As a new user, I want to create an account with my email so I can use the product without developer-only access.*
**AC:**
- User can register with email via magic link OR Google OAuth.
- On registration, a User record is created in the backend.
- Session persists across browser reloads until explicit logout or 30-day expiry.
- No password-based registration in v1 (magic link only reduces friction and eliminates password reset flows).

**US-02 — Logout**
*As a logged-in user, I want to log out so I can use shared devices safely.*
**AC:**
- Logout clears session client + server side.
- Redirects to landing / login page.

### 3.2 Case Creation & Invite (P0)

**US-03 — Create a case**
*As the initiator, I want to describe my conflict and invite the other party.*
**AC:**
- User fills structured form: category (select), main topic (text, 1 sentence), description (text, multi-paragraph), desired outcome (text).
- Form selects a template (implicit: category → default template for that category; admin can override).
- On submit, a Case record is created with status `DRAFT_PRIVATE_COACHING` and an invite link is generated (unique, unguessable token, single-use).
- Initiator sees a screen with the invite link + copy button + "how to share this" guidance.

**US-04 — Accept an invite**
*As the invited party, I want to click a link and join the case after creating my account.*
**AC:**
- Invite link routes to a landing page explaining what Conflict Coach is.
- If not logged in, user can register / log in; invite token survives the auth flow.
- Token consumption binds the invited party's User to the Case (role: `INVITEE`).
- Token is marked `CONSUMED` after use; reusing it fails with a clear error.
- Invited party then fills their own case form (same shape as initiator's) — their entries are private to them.

**US-05 — Case lifecycle status visibility**
*As either party, I want to see where my case is in the process.*
**AC:**
- Dashboard shows all cases for the logged-in user with current status and the other party's status (at phase-level only — e.g., "Jordan has completed their private coaching" — never content).

### 3.3 Private Coaching (P0)

**US-06 — Private coaching conversation**
*As a party, I want a confidential chat with an AI coach to help me articulate my position.*
**AC:**
- Each party has a private chat channel with the Private Coach (chat UI: stream messages, markdown rendering, typing indicator).
- No template content is applied to the Private Coach — it is an open, general-purpose AI conversation.
- Private Coach messages and user messages are stored and visible to that party only.
- User can end the private coaching phase explicitly (button: "I'm ready for the joint session"). This sets their per-party state to `PRIVATE_COACHING_COMPLETE`.

**US-07 — Private coaching is truly private**
*As a party, I want hard guarantees that nothing I said in private leaks.*
**AC:**
- Security test: a request for the other party's private transcript from any logged-in session returns 403 / not-found.
- The Coach AI, when called, never quotes or closely paraphrases the other party's raw input in any user-visible output (see §6 Privacy Model for enforcement details).
- This rule is enforced at three layers: (1) prompt instruction, (2) server-side response filter, (3) UI never renders the other party's raw transcript.

### 3.4 AI Synthesis (P0)

**US-08 — Individualized pre-joint guidance**
*As a party, after both private coaching sessions are complete, I want AI-generated guidance on how to approach the joint session.*
**AC:**
- When both parties have marked private coaching complete, case moves to status `READY_FOR_JOINT`.
- The system generates per-party synthesis: areas of likely agreement, genuine points of contention, suggested communication approaches.
- Synthesis is derived from both parties' private content but surfaces no direct quotes or close paraphrases of the other party (see Privacy Model).
- Each party sees only their own synthesis.

### 3.5 Joint Chat & Coach (P0)

**US-09 — Enter the joint session**
*As a party, I want to join the facilitated chat with the other party and the AI Coach.*
**AC:**
- From the dashboard, each party can enter the Joint Chat once status is `READY_FOR_JOINT`.
- The Coach AI posts an opening message grounded in the case's main topic.
- Both parties can see each other's messages + the Coach's messages in real time (reactive updates, no refresh).

**US-10 — Coach facilitates in real time**
*As a party, I want the Coach to help keep the conversation productive.*
**AC:**
- Coach intervenes automatically on inflammatory content (detection via Claude call on new messages).
- Coach posts periodic summaries when new points of agreement emerge.
- Parties can @-mention the Coach to request a specific intervention ("Coach, can you summarize where we are?").

**US-11 — Resolution & case closure**
*As a party, I want to formally close the case when we've reached resolution.*
**AC:**
- Either party can propose closure with a summary of agreed outcomes.
- The other party must confirm before case closes.
- Closed cases transition to status `CLOSED_RESOLVED` and become read-only.
- Closed cases remain accessible on the dashboard.
- A party can also close unilaterally with `CLOSED_UNRESOLVED` (walk-away); the other party is notified.

### 3.6 Draft Coach (P0)

**US-12 — Draft a message with AI help**
*As a party in the joint chat, I want help crafting a message before I send it.*
**AC:**
- In the joint chat, user can click "Draft with Coach" to open a private side panel.
- Draft Coach engages in an exploratory back-and-forth (intent, tone, framing) — not a single-shot rewrite.
- When the user indicates readiness, Draft Coach produces a polished, ready-to-send draft.
- User can: send as-is, edit, continue refining with Coach, or discard.
- **Hard rule:** No message is sent to the joint chat without an explicit user "Send" click.
- Draft Coach conversation is private to that user — invisible to the other party and invisible to the joint-chat Coach.

### 3.7 Solo Test Mode (P0)

**US-13 — Single-user solo mode**
*As a developer / demo user, I want to play both parties in one session to test the flow end-to-end.*
**AC:**
- A "New Solo Case" option on the dashboard creates a case with both `INITIATOR` and `INVITEE` bound to the same user.
- UI has a clear party-toggle affordance (top nav: "Viewing as Alex / Viewing as Jordan").
- AI responses behave as if each party were separate (separate private coaching contexts).
- Solo cases are flagged distinctly in the database and UI to avoid confusion with real cases.

### 3.8 Template Management (P1)

**US-14 — Admin template CRUD**
*As an admin, I want to create, edit, and version coaching templates by category.*
**AC:**
- Admin-only route (`/admin/templates`), gated by a server-side `role: "ADMIN"` check (not a client flag).
- Admin can create a new template: category, role (Coach / Draft Coach / both), global guidance, role-specific instructions.
- Editing a published template creates a new version; the previous version is preserved.
- Cases pin to a specific template version at creation and are unaffected by later edits.
- Admin can archive templates (soft-delete); archived templates disappear from the category picker but remain resolvable by pinned cases.
- Audit log records each create / publish / archive action with admin identity + timestamp.

### 3.9 Dashboard & Navigation (P0)

**US-15 — Dashboard**
*As a user, I want to see all my active and closed cases at a glance.*
**AC:**
- Dashboard lists cases grouped by status (Active / Closed).
- Each row shows: other party name, category, created date, current status, last activity time.
- Click → case detail view with phase-appropriate UI (private coaching, synthesis, joint chat, etc.).

### 3.10 Nice-to-Haves (P2 — deferred unless time permits)

- **US-16:** Email notifications on state transitions (new invite, private coaching complete, new message in joint chat after 5-min quiet period).
- **US-17:** Voluntary transcript sharing — a party can explicitly choose to share their own private coaching transcript with the other party (separate consent step, see Privacy Model §6.5).
- **US-18:** Export / download case history as a PDF after closure.
- **US-19:** "Coach, rephrase this" inline tool in Draft Coach (one-shot rephrase without full conversation).

---

## 4. Functional Requirements Summary

| # | Requirement | Priority |
|---|-------------|----------|
| FR-01 | Magic-link + Google OAuth authentication | P0 |
| FR-02 | Case creation with structured form + invite link generation | P0 |
| FR-03 | Invite link redemption tied to account creation/login | P0 |
| FR-04 | Private coaching chat per party, fully isolated | P0 |
| FR-05 | Phase-gated state machine (no skipping phases) | P0 |
| FR-06 | AI Synthesis with no cross-party raw-content leakage | P0 |
| FR-07 | Real-time joint chat with both parties + Coach | P0 |
| FR-08 | Draft Coach with user-approval send gate | P0 |
| FR-09 | Solo mode (one user playing both parties) | P0 |
| FR-10 | Admin template CRUD with immutable versioning | P1 |
| FR-11 | Case closure with confirmation + read-only archive | P0 |
| FR-12 | Dashboard listing user's cases with phase visibility | P0 |

---

## 5. Non-Functional Requirements

### 5.1 Privacy & Security
- **Zero raw cross-party leakage.** Enforced at prompt layer, server response layer, database access control, and UI rendering (defense in depth).
- **Encryption at rest and in transit.** Convex provides TLS + encrypted storage by default; no additional work needed for v1 but called out as a requirement.
- **Minimal PII.** We collect: email, optional display name. No phone, address, DOB.
- **Data retention.** Active and closed cases are retained indefinitely in v1; a user can request full deletion via support email (manual in v1, self-serve in v1.1).
- **Audit logging** for admin actions (template CRUD) from day one.
- **HIPAA / SOC 2 posture.** Convex is HIPAA-compliant and SOC 2 Type II certified, giving a defensible baseline even though v1 is not marketed as HIPAA-covered.

### 5.2 Performance
- AI streaming: first token latency target < 2s for private coaching, < 3s for joint-chat Coach (acceptable due to Claude API latency + facilitation context size).
- Joint chat message propagation (user → other user's screen): target < 500ms (Convex reactive queries; in practice usually < 200ms).
- Dashboard load: < 1s to first meaningful paint.
- Supports 50 concurrent active cases in v1 (more than enough for launch / beta).

### 5.3 Reliability
- AI call retry on transient API failure: 1 retry with exponential backoff, then surface error to user with a "Retry" button (never silently fail).
- Messages persist before AI is called; if AI call fails, user message stays, AI response shows an error state that can be retried.
- No message loss under network failure; client reconnection reconciles state via Convex reactive queries.

### 5.4 Accessibility
- WCAG 2.1 AA target for v1.
- Keyboard-navigable throughout (critical paths tested via Playwright with keyboard-only runs).
- Screen reader support for chat UIs (aria-live regions for incoming messages).
- Color contrast ≥ 4.5:1 for text.

### 5.5 Browser Support
- Latest 2 versions of Chrome, Safari, Firefox, Edge.
- Mobile Safari / Chrome on iOS 16+ / Android 12+.
- No IE, no Chrome < 100, no Safari < 15.

### 5.6 One-Shot Generatability
The tech spec must be precise enough for Claude Code to generate the full app in a single run. This is treated as an NFR on the *spec itself*: no ambiguous state transitions, no aspirational API contracts, all schemas normative.

---

## 6. Privacy Model (Requirement-Level)

This section defines the product's privacy behaviors as requirements; the tech spec defines enforcement mechanisms.

### 6.1 Visibility Matrix

| Data | Visible To |
|------|------------|
| Party A's private coaching messages | Party A + Private Coach (AI) only |
| Party B's private coaching messages | Party B + Private Coach (AI) only |
| Each party's personal synthesis | Only that party |
| Joint chat messages | Both parties + Coach (AI) |
| Draft Coach conversation | Only the drafting party |
| Templates (metadata) | Both parties (read-only), Admin (read-write) |

### 6.2 The "AI as Privacy Boundary" Principle
The Coach AI has server-side access to both parties' content in order to be an informed neutral facilitator. However, the Coach's outputs must never quote or closely paraphrase the other party's raw private input. It synthesizes only.

### 6.3 Enforcement Layers
1. **Prompt instruction layer** — system prompts contain explicit anti-quotation rules.
2. **Server response filter** — before emitting Coach output to either party, a lightweight validator (regex + embedding similarity) checks for near-verbatim strings from the other party's private transcript; if found, the response is regenerated.
3. **Database access control** — Convex functions enforce per-user visibility; no query returns another user's private transcript.
4. **UI layer** — client code never has access to the other party's private transcript, even transiently.

### 6.4 No User-Facing Retrieval of Other Users' Data
There is no API endpoint, admin action, support action, or UI feature that allows one user to read another user's private coaching transcript. Full stop. Admin has no such capability either — templates and audit logs are the only admin surfaces.

### 6.5 Voluntary Sharing (Deferred to v1.1)
A party may explicitly choose to share their *own* private transcript with the other party. This is a deliberate user action on their own data, with a confirmation step. Out of scope for v1.

---

## 7. Success Metrics

### 7.1 Launch Criteria (must be true before opening to beta users)
1. Two real people can complete end-to-end mediation with no developer intervention.
2. Neither party can access the other's raw private data under any flow (verified via targeted Playwright security test).
3. Draft Coach never auto-sends (verified by Playwright and manual review).
4. Solo mode works end-to-end (verified by Playwright).
5. Admin can create, edit, version, and archive a template without breaking existing cases.
6. Clean-env setup: `git clone && npm install && npx convex dev && npm run dev` runs the full app.
7. Playwright suite passes 100% in CI.

### 7.2 Beta Success Metrics (first 30 days of beta)
| Metric | Target |
|--------|--------|
| Case creation completion rate (started → invite sent) | > 70% |
| Invite redemption rate (invite sent → invited party joins) | > 50% |
| Private coaching completion (joined → marked complete) | > 60% |
| Reach joint chat (both complete private coaching) | > 40% |
| Reach resolution (joint chat → `CLOSED_RESOLVED`) | > 25% |
| Median time from case creation to closure | < 7 days |
| Draft Coach invocation rate in joint chat | > 40% of messages |
| Zero privacy incidents | 100% |
| User-reported NPS (post-closure survey) | > 30 |

These targets are intentionally modest — this is an unproven category and baseline attrition at each step will be high.

---

## 8. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| AI leaks one party's wording to the other despite prompt rules | Medium | Severe (trust-breaking) | Defense in depth: prompt + server-side filter + audit sampling |
| Invited party never joins (one-sided usage) | High | Moderate | Clear share messaging; in v1.1 add nudge emails; accept this as a funnel reality |
| Coach AI gives advice that escalates rather than de-escalates | Medium | Severe | Template-driven prompts; conservative defaults; in-app "Report this response" button with internal review |
| Users share traumatic content; AI must not harm | Medium | Severe | Safety guardrails in prompts; crisis-resource fallback card triggered on keyword heuristics; clear ToS stating not for crisis / abuse situations |
| Convex vendor lock-in | Medium | Moderate | Convex backend is open-source and self-hostable; data exports possible |
| Convex Auth is beta — unexpected auth bugs | Low | Moderate | Accepted for v1; can swap to Clerk without data model changes |
| One-shot generation fails and spec needs rework | Medium | Moderate | Plan for spec iteration; don't bet the project on one-shot success |
| Legal exposure from handling sensitive conflict content | Medium | High | Clear ToS: not a substitute for legal, therapy, or professional mediation; no binding outcomes; explicit "not for abuse / safety situations" language |
| LLM API cost runs hot in joint chat (many turns) | Medium | Moderate | Use Haiku for lightweight classification (inflammatory detection), Sonnet for coaching; transcript compression; per-case budget cap with graceful degradation |

---

## 9. Release Plan

### 9.1 Phase 0 — Spec & Foundations (Week 0)
- Complete tech spec and design doc
- Stand up Convex project, base schema, auth, empty React app
- CI pipeline with lint + typecheck + Playwright placeholder

### 9.2 Phase 1 — Core Flow (Weeks 1–3)
- Auth (magic link + Google OAuth)
- Case CRUD + invite flow
- Private coaching chat (single party working end-to-end)
- Dashboard with status
- Solo mode skeleton

### 9.3 Phase 2 — Joint Session (Weeks 4–5)
- AI synthesis
- Joint chat with real-time reactive updates
- Coach facilitator AI integration
- Draft Coach (including approval gate)
- Case closure flow

### 9.4 Phase 3 — Admin & Polish (Week 6)
- Admin template CRUD + versioning
- Audit logging
- Accessibility pass
- Error states, loading states, empty states
- Playwright E2E coverage of critical paths

### 9.5 Phase 4 — Beta (Week 7+)
- Internal dogfooding with real conflicts (Applied Labs team volunteers)
- Limited closed beta with 10–20 external users
- Iterate based on feedback
- Gate to public launch when Launch Criteria (§7.1) are fully met

---

## 10. Open Questions (to be resolved before or during Phase 1)

| # | Question | Owner | Decision-by |
|---|----------|-------|-------------|
| Q1 | Convex Auth (beta) vs. Clerk? | Eng lead | Before Phase 1 starts |
| Q2 | Exact safety keyword / escalation heuristics for crisis situations | Product + Safety | Before Phase 2 |
| Q3 | ToS copy, especially "not for abuse / crisis" language | Legal + Product | Before beta |
| Q4 | Branding / naming — "Conflict Coach" vs. the doc's "Conflict Resolution Arbiter" | Product | Before beta (locked to "Conflict Coach" in this doc pending override) |
| Q5 | Should the AI Coach have a name / persona, or stay generic "Coach"? | Product + Design | Before Phase 2 |
| Q6 | Per-case AI cost cap value and what happens when hit | Eng + Finance | Before beta |

---

## 11. Appendix

### 11.1 Changes from the v0.1 Story Document
- Renamed from "Conflict Resolution Arbiter" to "Conflict Coach" (shorter, warmer, less legalistic).
- **Platform decision closed:** web (React) only for v1. Telegram deferred.
- **Storage decision closed:** Convex (all-in-one: database, functions, auth, realtime). SurrealDB + RAG deferred to v1.1+; rationale — current transcript sizes fit comfortably in Claude's context window, and the existing transcript compression approach is simpler to reason about and debug.
- **AI provider decision closed:** Anthropic Claude (Sonnet 4.5+ for coaching/facilitation, Haiku 4.5 for classification tasks).
- Auth: magic link + Google OAuth (no password-based registration in v1).
- Added explicit personas, metrics, and risk register.
- Added release phasing.

### 11.2 Glossary
| Term | Definition |
|------|------------|
| Case | A single conflict mediation session between two parties |
| Party | One participant in a case (Initiator or Invitee) |
| Initiator | The party who created the case |
| Invitee | The party invited via link |
| Private Coach | The AI each party chats with privately during the private coaching phase |
| Draft Coach | The AI that helps a party craft a joint-chat message before sending |
| Coach | The neutral AI that participates in the joint chat visible to both parties |
| Synthesis | Per-party AI-generated guidance after both private coaching sessions complete |
| Template | A versioned configuration driving AI prompt behavior by category |
| Template Version | Immutable snapshot of a template pinned to cases created when it was active |
| Main Topic | Required framing step before private coaching: category + topic + template |
| Solo Mode | Testing mode where one user plays both parties |
| Phase / Status | Case lifecycle state (see state machine in tech spec §5) |

---

*Conflict Coach · PRD v1.0 · Applied Labs · April 2026*
```