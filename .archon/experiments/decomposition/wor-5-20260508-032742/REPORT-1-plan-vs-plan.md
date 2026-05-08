# v1 Plan vs v2 Plan — Comparison Report

Both plans decompose Epic WOR-5 (Conflict Coach v1) into a task graph. v1 was produced by run-1's `epic-decompose` workflow on 2026-04-30 against the same PRD/TechSpec/DesignDoc/StyleGuide attachments. v2 mark1 was produced by `v2-epic-decomposition-mark1` on 2026-05-08 with adversarial review + stack/design enrichment passes.

## Headline numbers

| Metric | v1 | v2 mark1 |
|---|---|---|
| Total tasks | 57 | 37 |
| Total estimated minutes | (not in plan; carried separately on Jira tickets) | 2,655 (~44 hours) |
| Plan format | Markdown | JSON |
| Phase structure | None (flat list with prose layer-grouping in narrative) | None (flat list — *gap, see below*) |
| Adversarial review | None | 3 rounds, converged 13 → 3 → 0 objections |
| Stack-specific enrichment | None | per-task `stack_practices` (mark1; wrong shape — see below) |
| Design-specific enrichment | None | per-task `design_practices` (mark1; same wrong shape) |
| Cost (planning side only) | ~$5 | ~$36 |
| Wall time | ~9 minutes | ~3h 44min |

## What the v2 plan got right

**1. Adversarial review caught real coverage gaps that the v1 plan would have shipped.**

The round-1 evaluator flagged 13 substantive objections, all addressed by round 3. Several would have caused dev-loop failures downstream:

- **`jointChat/enter` mutation gap.** The v1 plan named the READY_FOR_JOINT → JOINT_ACTIVE transition in T26 (joint chat backend) but never explicitly authored a mutation for it. v2's evaluator caught this and forced the generator to make `jointChat/enter` an explicit AC of T14. (Notably, this is the bug we hit as WOR-89 in run 1 — the invitee couldn't enter joint chat because the mutation wasn't idempotent. v2's evaluator structurally surfaces the work that would have prevented WOR-89.)
- **`tokenCount` schema drift.** v1 plan added `tokenCount` in a later cost-tracking ticket (T44) without updating the schema ticket (T3). v2 evaluator flagged this; v2 plan adds tokenCount as an AC of T2 (schema definition).
- **`COST_LIMITED` UI treatment.** v1 plan defined the backend behavior but no UI ticket renders it. v2 evaluator caught the gap; v2 plan adds it as an AC on T27 (joint chat view).
- **Crisis-resource fallback card.** PRD §8 risk register requires a crisis card on keyword detection. v1 plan never created a task for it. v2 evaluator caught it; v2 plan adds CrisisCard to T19b and integration to T12 + T25.
- **Unilateral-close notification.** PRD US-11 requires the other party be notified. v1 plan only had backend audit logging (T39); no UI surface for the recipient. v2 evaluator caught it; v2 plan adds the indicator to T22 (dashboard).
- **Cross-browser Playwright runs.** NFR §5.5 requires Chrome + Firefox + Safari support. v1 plan ran Playwright in Chromium only. v2 plan configures all three browsers.
- **Phantom dependency T34→T33.** v1 plan made E2E tests depend on the accessibility pass, serializing 240 minutes of independent work. v2 removed that dependency.

This is the highest-leverage thing v2 did. Each of these is a downstream defect the v1 plan would have produced.

**2. Sizing was challenged and corrected.**

The v2 evaluator flagged three undersized tasks. v1 plan would have shipped them at the wrong size; v2 corrected:

- T19 (shared UI components): v1 estimate 90 min for 10+ components. v2 evaluator flagged as 2× too low. v2 split into T19a (core chat components, 90min) + T19b (secondary components, 90min).
- T33 (accessibility pass): v1 estimate 120 min for full WCAG AA across 12+ routes. v2 evaluator flagged as half the realistic time. v2 raised to 240 min.
- T34 (E2E test suite): v1 estimate 90 min for 7 spec files. v2 evaluator flagged as no debug budget. v2 raised to 180 min.

Also: T17 (cost tracking) was architecturally misplaced in v1 — defined as a post-hoc hardening pass that would retroactively modify already-"done" tasks T12-T15. v2 evaluator caught the hidden modification dependency; v2 pushes token accumulation into T12-T15 and keeps T17 only for budget enforcement logic.

**3. Estimates per task are now first-class.**

v1 plan didn't carry estimates; they lived only on the Jira tickets. v2 plan has `original_estimate_minutes` on every task as part of the canonical artifact. The total comes out to 2,655 minutes (~44 hours of autonomous-agent work).

**4. Cuts merged some unnecessarily-fragmented v1 work.**

v1 had a fragmented backend layer (T11 dashboard backend, T13 case create backend, T34 invite redeem backend, T37 admin templates backend, T39 audit logging backend, T41 cron job — 6 separate backend tickets). v2 consolidated some of these where the cuts were artificially split:

- T9 in v2 = T11 + T13 from v1 (case CRUD + create)
- T11 in v2 = T37 + T42 from v1 (templates backend + seed data)
- T16 in v2 = T30 + T41 from v1 (case closure + abandoned cron)
- T36 in v2 = T57 (CI pipeline) merged with parts of T49 (E2E infra)

Whether this is good or bad depends on whether the merged tickets are still "one cohesive unit." See §"Concerns" below.

## Where v1 was better (or v2 was no improvement)

**1. v1 had separate frontend and backend tickets per feature; v2 sometimes merged them.**

v1's pattern was: T11 dashboard backend, T12 dashboard frontend (separate). T13 case create backend, T14 case create frontend (separate). T28 draft coach backend, T29 draft coach frontend (separate). The split is appealing because each ticket has one cohesive surface — backend mutations OR React components, not both.

v2 mostly preserves this split (T9 backend → T22 frontend; T13 synthesis → T26 ready-for-joint view) but in places merged related work (T16 case closure backend AND cron consolidation). Worth checking: did v2 cut at the right boundaries?

**2. Solo mode was simpler in v1.**

v1's T33 was "Solo mode (party toggle + dual-context simulation)" — single ticket. v2's T30 is the same conceptual thing but the AC list is much longer because v2 inlined more requirements (integrating PartyToggle into 4+ existing views, useSoloActingParty hook, URL param state, dashboard solo flag). Not necessarily worse, but the ticket got bigger.

**3. (CORRECTED) Both v1 and v2 have wrong-shape standalone test tickets — neither should exist.**

The architectural principle is: **tests are produced by the test-gen agent as part of each feature's pipeline, not as separate work**. v1 had 7 standalone E2E test tickets (T50–T56) plus T48 unit tests; v2 collapsed E2E into one (T34) and kept T35 "Vitest unit tests for core utility modules." Both shapes are wrong. The right answer is *zero* standalone test tickets — testing requirements live in each feature ticket's Test-Gen Brief, and the test-gen agent authors them as the feature is built.

So the v1 → v2 progression is: 8 wrong-shape test tickets → 2 wrong-shape test tickets. Better, not fixed. mark2 should eliminate them entirely.

## Concerns

### 1. v2 has no phase structure

The v2 plan is still a flat task list with implicit ordering through `depends_on` edges. The PRD itself has explicit phases (§9 release plan: Phase 0 foundations, Phase 1 core flow, Phase 2 joint session, Phase 3 admin & polish, Phase 4 beta), but neither v1 nor v2 captured those phases as first-class structure.

This was discussed in design conversations; the `epic-decompose` IR should be **phased** — first-class `phases: [...]` containing `tasks: [...]`. v2 mark1 didn't deliver this. Mark2 should.

### 2. v2 mark1's per-task `stack_practices` and `design_practices` are wrong-shape

mark1 instructed the stack-expert and design-expert passes to author per-task fields. The intent should have been a single canonical project-level rules document (`stack-rules.md`, `design-rules.md`) that the lowering pass reads and applies per-ticket. Per-task scattering caused:

- **convex-test mentioned only once in 9 backend tickets that need it** (T17 only). Not because the agent doesn't know it — when asked the canonical question directly, Claude names convex-test immediately. The fragmented per-task framing under-attended to specifics.
- The same content gets restated awkwardly across many tasks rather than once.
- The rules don't survive as a reusable artifact — they're embedded across 37 task entries instead of one referenceable document.

Mark2 fixes this: single canonical adviser pass producing one rules document.

### 3. v2 ticket count (37) might be undersized for the agent-loop

The single-developer principle is "smallest unit of work; one agent does one thing." 37 tasks for an Epic that produced 71 work items in run 1 (62 archon/* + 9 salvage tickets) is a 50% reduction in granularity. Some of that is good (eliminating fragmented cuts). Some of that may be bad — e.g., T34 collapsing 7 v1 E2E tickets into one is probably too coarse.

The right way to evaluate this is per-ticket inspection (Report #2 will look at this). The 37 number alone isn't a verdict.

### 4. Adversarial loop converged in 3 rounds without surprise

The evaluator caught 13 → 3 → 0 objections; the generator addressed every one. That's a clean adversarial pattern. But: was the threshold (8/10 across 5 dimensions) too easy? Three of the round-2 objections were minor wording issues (closureProposalSummary as a schema field; users/updateDisplayName signature precision; sendUserMessage's @-mention parameter). Mark2 might want to bump the threshold or add more dimensions of evaluation.

### 5. Cost ratio (7×) is real but might be the right floor

$36 v2 vs $5 v1. The v1 plan had downstream costs we know about — 9 manual salvages (most around $3-7 each in agent attempts plus my hand-fixing time) plus the salvage cost of the WOR-89-class bugs. If v2's better plan eliminates 5+ of those salvages, $36 is cheap. Need run-2 evidence to validate.

## Summary

v2 mark1's plan is **strategically better** than v1's plan. It catches real coverage gaps, corrects sizing errors, removes phantom dependencies, and produces a plan that would have prevented at least one bug class we hit in run 1 (the WOR-89 jointChat/enter idempotency).

It has **structural gaps** that mark2 should fix: no phase structure, per-task scattering instead of canonical rules document, possibly too-coarse cuts in some areas (E2E ticket).

It is **substantially more expensive** to produce (~7× the API-equivalent cost), but the cost of *not* catching the issues v2 found is higher in dev-loop salvage time.

The adversarial review pattern works as designed — the principle of separate evaluators that catch what generators miss is the right shape, and the implementation produced concrete value on this Epic.
