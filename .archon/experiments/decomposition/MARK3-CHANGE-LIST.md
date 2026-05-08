# Mark3 Change List

Refinements building on observed mark2 behavior. Each entry: what's changing, why, evidence. The bottom-line goal: combine mark2's structural improvements (canonical plan, advisers as document authors, fresh-context loops, AC checkpoints) with mark1's thoroughness (rich per-ticket detail, distinct backend/frontend/integration cuts, explicit cross-ticket dependencies).

Mark3 is still about decomposition only (no Jira). Engine-level changes stay in `ARCHIE_V3_CANDIDATES.md`.

---

## 1. Phase 0 is a hard human-input gate, not ordinary scaffolding

**Change.** The first phase becomes a strict setup gate that explicitly enumerates the external preconditions a human must satisfy before any code work can proceed. These tickets are flagged as human-only (carry `archon-blocked-pending` permanently); the rest of the pipeline waits for the human to manually unblock them.

For a project on Convex + Anthropic + Cloudflare + Google OAuth, Phase 0 includes (at minimum):

- Convex project created; deployment URL captured
- Convex env vars set (`CONVEX_DEPLOY_KEY`, `CONVEX_URL`)
- Email/magic-link provider credentials (e.g. Resend) — domain verified, API key configured
- Google OAuth client ID and secret
- Anthropic API key (or subscription credentials)
- Cloudflare Pages project + API token
- Production and preview site URLs
- Local `.env.local` populated for dev
- Decision on mock mode vs live mode for E2E tests

The decomposer authors one human-only ticket per precondition with explicit "what to do" instructions. Subsequent tickets list these as `depends_on` so the dev pipeline doesn't try to run them and doesn't start work that depends on a missing secret.

**Why.** Run 1 had ~18 infrastructure PRs that I authored by hand because they weren't decomposable into agent work — Convex setup, GH secrets, Resend domain verification, etc. None of those existed as Jira tickets in run 1. For greenfield-onboarding to work, those steps need to be visible as tickets even though Archie can't complete them.

**Evidence.** WOR-88 (magic-link Resend domain verification) — operational, no code change possible, but the user-visible bug went un-tracked until I filed it manually after the fact. Phase 0 surfaces this kind of work upfront.

---

## 2. Phases only where they represent real gates; everything else is milestones

**Change.** Drop rigid phase walls except for Phase 0. After Phase 0, organize work by **capability and user story**, using milestones for readability rather than as hard gates.

Recommended structure:

- **Phase 0** (hard gate): Human setup & environment
- **Milestone 1** (no hard gate): Foundation (scaffolding, schema, error helpers, design tokens, layout shell, routing)
- **Milestone 2** (no hard gate): Case, invite, dashboard
- **Milestone 3** (no hard gate): Private coaching + synthesis
- **Milestone 4** (no hard gate): Joint chat + draft coach + closure
- **Milestone 5** (no hard gate): Admin + launch hardening

Tickets within a milestone don't have artificial walls between them; tickets across milestones don't have implicit phase-boundary dependencies. **All cross-ticket dependencies are explicit `depends_on` edges.** Milestones are presentation, not enforcement.

**Why.** Mark2's strict 4-phase structure made the generator work backward from "balanced phase counts" rather than discovering the right cuts. Mark2 round-2 evaluator objections included two cross-phase boundary issues (compression dependency mis-routed, cost-tracking AC drift across phases) — symptoms of trying to organize prescriptively when the dependency graph should be the source of truth.

**Evidence.** P0 in mark2 has 4 tasks; v1 had ~7 foundation-level tasks. Mark2's cuts likely got merged to fit a cleaner phase structure. The user pushed back: "I am not sure about this approach at all, what cuts? we have literal user stories."

**Implementation.** The plan structure becomes:

```json
{
  "epic_title": "...",
  "phase_0": { "goal": "human gate", "tasks": [...] },
  "milestones": [
    { "milestone_id": "M1", "label": "Foundation", "tasks": [...] },
    ...
  ]
}
```

Or flatter still: a flat task list where each task carries `phase_or_milestone: "phase_0" | "M1" | ...` as a label, and phases/milestones are computed for display. Either way, milestones are not enforced gates.

---

## 3. Dependencies are explicit, not implicit-by-phase

**Change.** Every cross-ticket dependency that exists is declared as a `depends_on` edge. The decomposer must surface specific dependencies that mark2 hid behind phase boundaries.

Specific dependencies to enumerate explicitly (not exhaustive — these are examples of the class of dependency that needs to be surfaced):

- State machine → every mutation that transitions case status
- Prompt assembly → every AI role (private coach, draft coach, joint coach, synthesis)
- Privacy filter → synthesis action and joint Coach action
- Shared chat UI components → private coaching view, joint chat view, draft coach panel
- Template backend (schema + version pinning) → case creation, prompt assembly
- Cost tracking → every AI action that consumes tokens
- Solo role handling → every party-scoped query, every party-authored mutation, every per-party UI element

The adversarial evaluator gets a check: "for each cross-cutting concern (state machine, prompt assembly, privacy filter, etc), every dependent ticket has a `depends_on` edge to the concern's owning ticket."

**Why.** Mark2 hit this exactly: round-2 caught T9 (shared ChatWindow) missing from T10b's (private coaching backend) `depends_on`, even though T10b's frontend would clearly need ChatWindow. The dependency was implicit because both sat in P1; the evaluator caught it because of explicit cross-ticket review. Making this the norm rather than the exception means the evaluator catches more of these earlier.

---

## 4. Playwright is feature-owned, not end-loaded

**Change.** Every user-visible feature task owns its Playwright coverage. Tests are written alongside implementation in the same ticket flow (test-gen → dev-gen pipeline). A feature ticket is not complete until its local Playwright spec passes.

Final "E2E test infrastructure" tasks only handle fixtures, browser matrix configuration, artifact upload, and flake hardening — they don't own behavior tests.

Examples of feature-owned Playwright coverage:

- Invite ticket owns the two-browser invite redemption test
- Private coaching ticket owns the private-message isolation test
- Synthesis ticket owns the synthesis visibility/privacy test
- Joint chat ticket owns the reactive two-user message propagation test
- Draft Coach ticket owns the send-gate test
- Solo mode ticket owns the role-toggle isolation test
- Closure ticket owns propose / reject / confirm / read-only tests
- Admin template ticket owns version-pinning-after-publish/archive test

**Why.** Mark1 had 7 standalone E2E tickets; mark2 collapsed them into 1 ticket. Both are wrong. Tests are produced by the test-gen agent as part of each feature's pipeline; the feature ticket carries the test contract; the test gets written when the feature is implemented. Tacking E2E coverage on at the end is the test-as-afterthought antipattern.

**Implementation.** Plan-builder rule: **no standalone "E2E tests for X" tickets.** Every feature ticket includes its Playwright spec coverage as part of its Test-Gen Brief Test Plan (which already enumerates per-AC tests with layer = unit / integration / e2e). The compose-tickets prompt reinforces this.

A single "Playwright infrastructure" ticket may exist in Milestone 1 (config, fixtures, mock-mode shim, browser matrix) but it does not author any feature-behavior specs.

---

## 5. Restore DesignDoc fidelity

**Change.** Mark2's plan under-represented UI specificity from the DesignDoc. Add or expand tasks for the DesignDoc-specific UI work that mark2 either merged into broader tickets or omitted:

- Design tokens & visual language (mark2 has T18 but possibly under-specified)
- Visible privacy labels and lock affordances (the privacy banner, lock-icon-as-decorative-vs-button calls)
- Dashboard status glyphs (specific iconography per case status)
- Post-create invite sharing screen
- Progressive case creation form (multi-step, not single page)
- Draft Coach side panel vs bottom sheet (responsive treatment)
- Ready-for-joint synthesis card layout
- Closed case tabs (resolved vs unresolved vs abandoned)
- Exact error, loading, empty states (per surface, not generic)
- Accessibility and focus behavior (per component, not just a final pass)

These can be ACs on existing tickets where they fit naturally, or new tickets where the work is substantial.

**Why.** Run 1 had ~5 separate Bug tickets (WOR-82..WOR-86) for nav/layout/styling regressions because those concerns were loose in the original plan. Mark2's plan gives them less attention than mark1 did because the milestone-level grouping doesn't surface UI specificity well.

**Implementation.** The design adviser's `design_rules` document does the heavy lifting on what the design language *is*; the plan-builder must explicitly identify UI work in each user story that requires a DesignDoc-specific implementation, not just "implement the page."

---

## 6. Expand backend/API detail (mark1-level)

**Change.** Backend tickets need ACs at mark1's level of specificity, not mark2's level. Mark2 had ~10 ACs per backend task; mark1 had similar. Both went into v2 ticket Test-Gen Brief but the AC list itself shrank in mark2.

Specific backend areas where ACs need to be exhaustive:

- All Convex queries, mutations, actions — input validation, auth, error codes, observable behavior
- Invite preview / redeem / token consumption — including the consumed-token failure case
- Private message access control — every read path, every cross-party rejection
- Synthesis generation and response filtering — privacy invariant ACs explicit
- Joint chat message visibility — both directions
- Draft Coach session lifecycle — start, message exchange, mark-ready, send, discard
- Closure mutations — propose, accept, reject, unilateral, abandoned
- Abandoned-case cron — the schedule, the filter query, the transition
- Admin template versioning — pin-on-create, no retroactive change, archive doesn't break pinned
- Audit logging — what events, what fields, what visibility

**Why.** Backend tickets carry the invariants the dev pipeline measures "done" against. Compress ACs into "all queries return 403 for non-parties" instead of listing each query and the dev pipeline writes one test that passes broadly while specific cases break.

**Implementation.** Adversarial evaluator's testability dimension gets an explicit rule: "for backend tasks, count ACs against complexity. A mutation with auth + validation + transactional invariants + error codes needs ~6+ ACs. Fewer is suspicious."

---

## 7. Clarify spec deviations

**Change.** When the plan introduces concepts or fields not fully normalized in the source docs, label them as decisions explicitly. Don't pretend they're verbatim from the spec when they're inferred or extended.

Specific deviations from mark2 to label:

- Cost tracking fields (`costUsd`, `costTokens`, `costLimited`) — were these in the TechSpec, or did the decomposer infer them?
- `COST_LIMITED` — is this a case status (mark2 treats it as one in places) or a flag on cases?
- Crisis safety card / guardrails — PRD §8 risk register mentions, but is the card a v1 deliverable or a v1.1 hedge?
- Cloudflare deployment — is "deploy works in production" a launch criterion or just setup verification?

Each deviation gets a `decision` field on the relevant task or in `planning_assumptions`, with a one-line explanation of what was decided and why.

**Why.** Run-1 hit at least one of these (WOR-89 idempotency was an inferred behavior the PRD didn't state). Surfacing decisions makes them reviewable; hiding them in ACs makes them silently ship.

---

## 8. Templates and versioning live early

**Change.** Template *data model* + version pinning are foundational. Admin UI for editing templates is later. Don't bundle them.

Recommended split:

- **Early** (Milestone 1 or 2): template schema; default templates seed; template version pinning logic; the rule that case creation pins a templateVersionId
- **Later** (Milestone 5): admin UI for create / edit / publish / archive; version-history browsing; audit log UI

**Why.** Case creation depends on pinned template versions. AI prompt assembly depends on the pinned template content. If template data model lands in Milestone 5 alongside the admin UI, every earlier feature has a placeholder for it; if it lands in Milestone 1, dependent features can build against the real model.

Mark1's v1 plan had T37 admin templates backend (late) and T38 admin templates UI (later) bundled. Mark2 did similarly. Splitting the backend earlier is the architectural fix.

---

## 9. Solo mode role isolation is explicit

**Change.** Solo mode is dangerous because both parties share one `userId`. The plan must require role-aware queries, not just user-aware queries.

Add ACs that verify role isolation specifically:

- Initiator private coaching messages are invisible when viewing as invitee
- Invitee private coaching messages are invisible when viewing as initiator
- Each party receives separate synthesis (not same string for both)
- Draft Coach context changes correctly when toggling solo role
- Joint chat authorship uses the selected solo role (not the user's default)

These ACs go on the solo-mode ticket (the role toggle / `useSoloActingParty` hook integration ticket) AND on every party-scoped query/mutation/UI ticket as additional ACs that the solo case must satisfy.

**Why.** Run 1's WOR-86/87 territory had several bugs in this area — components reading user-scoped data when they should have been reading role-scoped data in solo mode. The plan didn't make it explicit; the implementation slipped.

---

## 10. Break oversized tasks apart

**Change.** Where mark2 combined backend + frontend + tests + security + AI behavior into one ticket, split. The standard split pattern:

- Backend (action / query / mutation)
- Frontend (view / component)
- Privacy / security test (separate, even though not a "tests for X" ticket — these are behavioral tests on the surface they verify)
- Playwright behavior test (owned by the feature, but possibly its own ticket if the test is complex)
- Integration / hardening pass

Specific high-risk areas to split:

- Private coaching
- Synthesis
- Joint chat Coach
- Draft Coach
- Solo mode
- Closure flow
- Admin templates
- Cost tracking

**Why.** Mark2's "sizing 8" evaluator scoring used vibes-based judgment. The actual rule the user wants: **one primary code surface per ticket**. A ticket whose Contract.Files lists 5 files spanning backend / frontend / tests is wrong-sized regardless of what the evaluator scored.

**Implementation.** Plan-builder PROCESS checkpoint: "every ticket's Contract.Files lists files belonging to one primary surface plus its tests. If a ticket's files span backend and frontend, split it." Adversarial evaluator gets the same check and flags violations as objections.

---

## 11. The bottom line

Mark2's structure is the right foundation:
- Plan as canonical artifact ✓
- Advisers as canonical-document authors ✓
- Fresh-context per loop iteration ✓
- AC checkpoints in compose-tickets ✓
- Test-Gen Brief with Contract + Test Plan separation ✓

Mark2's omissions / over-prescriptions:
- Phases as walls instead of milestones-with-explicit-dependencies
- Phase 0 not a real human-input gate
- Backend ACs reduced from mark1 levels
- Playwright still treated as separable from features
- DesignDoc fidelity reduced
- Cuts merged into multi-surface tickets
- Spec deviations not labeled as decisions
- Solo role isolation not made explicit

Mark3 = mark2's structure + mark1's thoroughness. The change list above is how to land that.

---

## 12. Open questions — decide while building mark3

- **Format of Phase 0 human-only tickets.** Same ticket schema as feature tickets, or a different schema (since they have no test contract, no implementation surface)? Probably same schema with `human_only: true` flag and the AC list serving as the human's checklist.
- **How does compose-tickets know which Playwright tests an individual feature ticket should own?** Likely: the test plan adviser (new in mark3?) or the feature-owned Playwright rule encoded as a directive in `stack_rules.playwright`.
- **Should mark3 have a separate "test plan adviser" pass?** The Playwright-by-feature rule, the test-layer mapping rule (unit vs integration vs e2e), the "use convex-test for runtime tests" rule — all could be authored as a `test_plan_rules` document at adviser stage and consumed per-ticket.
- **Does the review-and-improve loop earn its cost in mark2?** TBD pending mark2 outputs. If compose-tickets in mark2 produces strong tickets directly, drop review-and-improve in mark3. If review-and-improve catches material drift, keep it.
- **What's the right shape of "specs deviation labels"?** Frontmatter field on the ticket? Section in the plan? `planning_assumptions` array?

These get answered after we observe mark2's full output and write the mark3 prompts.
