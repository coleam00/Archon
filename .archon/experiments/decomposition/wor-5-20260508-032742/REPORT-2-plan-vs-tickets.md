# v2 Plan vs v2 Tickets — Lowering Fidelity Report

**Note: this report's headline finding turned out to be wrong on closer inspection. See "Correction" section at the end. The summary: ACs weren't lost — they were routed to the Test-Gen Brief's subsections instead of staying in the AC list. The actual lowering question is "is this routing the right architecture?" not "is content being dropped?"**

The decomposition plan is the AST. The tickets are the lowered output. This report checks whether the lowering pass (compose-tickets loop) and the polish pass (review-and-improve loop) faithfully preserve the plan's intent.

## Headline numbers

| Metric | Value |
|---|---|
| Tasks in plan | 37 |
| Tickets produced | 37 (raw) + 37 (reviewed) |
| Coverage | Every task ID has a ticket; every ticket maps to a task ID. No orphans, no missing. |
| Section structure consistency | 37/37 reviewed tickets have all 6 expected sections (Acceptance Criteria, Implementation Notes, Test-Gen Brief, Stack Practices, Design Practices, Traceability). |
| **AC preservation: plan → raw tickets** | **208 of 330 ACs preserved (63%); 122 ACs lost in lowering (37%)** |
| **AC preservation: plan → reviewed tickets** | **220 of 330 ACs preserved (67%); 110 lost (33%)** |
| Tickets where AC count exactly matches plan | 4 / 37 (T1, T2, T3, T31) |
| Tickets where ACs were summarized/dropped | 33 / 37 |
| Tickets where review-and-improve added ACs back | (small handful — net of +12 across all tickets) |

## The big finding

**The compose-tickets loop is consolidating ACs rather than preserving them.** The plan specifies 11 ACs for T8 (case state machine module); the resulting ticket has 3. The 8 missing ACs are not noise — they are concrete, individually testable assertions like "BOTH_PRIVATE_COACHING→READY_FOR_JOINT requires both partyStates.privateCoachingCompletedAt set AND both synthesisTexts populated" and "JOINT_ACTIVE→CLOSED_RESOLVED requires other party's closureProposed=true" — exactly the kind of detail the dev pipeline downstream needs.

Concrete example, T8 plan:

```
- Each transition function is pure: takes current case state + relevant party states, returns new status or throws ConvexError CONFLICT
- DRAFT_PRIVATE_COACHING→CLOSED_ABANDONED: triggered by invitee declining; explicitly tested
- BOTH_PRIVATE_COACHING→READY_FOR_JOINT: requires both partyStates.privateCoachingCompletedAt set AND both synthesisTexts populated
- READY_FOR_JOINT→JOINT_ACTIVE: any party can trigger; idempotent if already JOINT_ACTIVE
- JOINT_ACTIVE→CLOSED_RESOLVED: requires other party's closureProposed=true
- Sending a joint message when case is not JOINT_ACTIVE throws CONFLICT
- All pure TypeScript, no DB calls — fully unit-testable
- Unit test: all 9 valid transitions succeed from correct precondition state
- Unit test: 8+ illegal transitions (wrong source state) each throw CONFLICT
- Unit test: marking PC complete twice is idempotent (no error, state unchanged)
- Unit test: DRAFT_PRIVATE_COACHING→CLOSED_ABANDONED (decline) succeeds and returns CLOSED_ABANDONED
```

T8 reviewed ticket:

```
- AC1: Each transition is pure: takes state, returns new status or throws CONFLICT
- AC2: DRAFT_PRIVATE_COACHING→CLOSED_ABANDONED: invitee decline, explicitly tested
- AC3: All 9 valid transitions and 8+ illegal transitions tested
```

The agent took the plan's 11 specific ACs, collapsed several into "all 9 valid transitions and 8+ illegal transitions tested" (one bullet for two former ACs, with the specific transition rules dropped), and skipped:

- The READY_FOR_JOINT→JOINT_ACTIVE idempotency requirement (the WOR-89 bug we hit in run 1!)
- BOTH_PRIVATE_COACHING→READY_FOR_JOINT precondition
- JOINT_ACTIVE→CLOSED_RESOLVED precondition
- The "pure TypeScript, no DB calls" invariant
- Multiple specific unit-test assertions

That's not lowering; that's editing. The lowering pass should preserve every AC.

The same pattern appears across 33 of 37 tickets. Worst offenders by raw count of ACs lost:

| Task | Plan ACs | Reviewed ACs | Lost |
|---|---|---|---|
| T14 (Joint chat backend + Coach facilitation) | 14 | 4 | -10 |
| T8 (Case state machine module) | 11 | 3 | -8 |
| T34 (Playwright E2E test suite) | 11 | 3 | -8 |
| T5 (Privacy response filter) | 10 | 3 | -7 |
| T12 (Private coaching backend) | 10 | 4 | -6 |
| T15 (Draft Coach backend) | 10 | 4 | -6 |
| T16 (Case closure backend) | 8 | 3 | -5 |
| T13 (AI synthesis backend) | 9 | 4 | -5 |
| T36 (CI pipeline) | 9 | 4 | -5 |

These are the highest-leverage tickets for downstream correctness. T14, T8, T5, T12 are all canonical Convex backend tasks where the dropped ACs encode the invariants the dev-loop must satisfy.

## Where the loss happened

Raw tickets (compose-tickets output) already had the loss; review-and-improve recovered only ~12 ACs (net) across the whole batch. **Compose-tickets is the lossy stage.**

The compose-tickets prompt says:

> `## Acceptance Criteria` — bulleted list of T.acceptance_criteria. Verbatim from the plan.

The "Verbatim from the plan" instruction is *there* but not strict enough to prevent the agent from consolidating. The instruction works for short AC lists; for plans with 8–14 detailed ACs per task, the agent reflexively rolls them up.

## Why this matters

ACs are how the dev-loop measures done. Each AC is a specific assertion the implementation must satisfy. Lost ACs translate directly into:

- **Implementations that pass the ticket but miss requirements.** "AC3: All 9 valid transitions tested" doesn't tell the dev-loop *which 9 transitions* — the specific assertion got rolled up. The dev agent might author tests for 5 transitions and the reviewer can't tell because the AC is vague.
- **Test-gen working from incomplete contracts.** The Test-Gen Brief is supposed to be the canonical spec for both test-gen and dev-gen. If 33% of ACs are missing, the brief is missing the same content.
- **Reviewer agents downstream evaluating against the wrong bar.** "Did this implementation satisfy the ACs?" If the ACs are too vague, a sloppy implementation can satisfy them.

This is exactly the WOR-87/WOR-54/WOR-55-class drift we discussed — the test-author and the code-author disagree on what "done" means because the contract that bridges them is too loose. v2 mark1 introduced richer Test-Gen Brief structure but dropped 33% of the ACs that the structure was supposed to express. Net effect on the contract's strictness: probably worse than v1, not better.

## Where lowering held up

**4/37 tickets matched plan AC count exactly:** T1 (project scaffolding), T2 (schema), T3 (auth), T31 (profile). These are tasks with fewer, less detailed ACs. The lowering agent is fine on small AC lists.

**Section structure was perfectly preserved:** every reviewed ticket has all 6 expected sections in the right order. The template-following discipline works.

**Stack/Design Practices were carried through.** Whatever the stack-expert and design-expert wrote in the per-task fields made it into the tickets verbatim. (Subject to the earlier finding that the per-task scattering was the wrong shape — but mechanically, the lowering preserved them.)

**Implementation Notes are substantive.** Spot-checked tickets have multi-paragraph Implementation Notes with specific tech-stack guidance, ordered bootstrap steps, anti-patterns named. The lowering agent used the source material well in this section.

**Test-Gen Brief structure is consistent.** Every ticket has Files, Exports, Signatures, Queries used, Invariants, Non-goals, Tested-by subsections. The rigor of the contract structure landed.

## What this means for mark2

**1. Compose-tickets prompt needs much stricter AC preservation.** Not "verbatim" as guidance but enforced. Probably the structurally correct fix is to lift ACs from the plan JSON directly with no agent rewriting:

> The Acceptance Criteria section is rendered from `T.acceptance_criteria` verbatim, one bullet per AC. Do not consolidate, summarize, or rephrase.

Actually stronger: this section should be *deterministic*, not AI-authored. A bash node could read the plan JSON and emit the AC bullets directly, no agent involvement. Same goes for Traceability (also deterministic from plan fields). Only Implementation Notes and Test-Gen Brief need agent authoring. Stack Practices and Design Practices, in mark2, will come from canonical rules docs and could also be partially deterministic (lookup-and-render).

**2. Review-and-improve isn't catching this kind of drift.** It was supposed to "improve tickets against the plan" but didn't notice that 33% of ACs were missing. Either its prompt isn't pointed at AC fidelity, or it has the same consolidation reflex. Mark2 should give review-and-improve an explicit "diff this ticket's ACs against the plan; restore any that are missing" responsibility, not just a generic "improve" framing.

**3. The lowering pass is doing too much "creative" work.** Implementation Notes is the right place for the agent to add substance (interpretive, prose, drawing on the spec). Acceptance Criteria is not — that's a transcription job. The mark2 architecture should split lowering into "deterministic transcription" (ACs, Traceability) + "AI authoring" (Implementation Notes, Test-Gen Brief, Stack/Design references). The agent does narrative; bash renders structure.

**4. The "section structure conformance" success doesn't substitute for content fidelity.** Every ticket has the right sections, but the most important section is partially empty. Surface uniformity isn't enough.

## Bottom line

v2 mark1 produced **structurally consistent tickets with materially incomplete content.** The lowering loses one third of the plan's ACs to over-eager agent consolidation. Mark2 must address this directly — the easy fix is making AC rendering deterministic; the deeper fix is recognizing that lowering is partly transcription and partly authoring, and only the authoring parts should be agent work.

---

## Correction

After spot-checking T8's Test-Gen Brief in detail, the headline finding above is wrong.

**The plan's 11 ACs for T8 are not missing.** They were routed into the Test-Gen Brief's subsections — the Exports table names every state-machine function, the Signatures block has the TypeScript declarations, the Invariants section captures the transition rules, and the Tested-by table maps each AC to specific test assertions covering valid and illegal transitions. The skeletal 3-bullet AC list is what's left after the agent moved the implementation-contract ACs to where v2's section structure says implementation contracts belong.

Compare to v1's WOR-29 (run-1's lowering of the same conceptual task). WOR-29 has 6 ACs, all preserved verbatim from v1's plan. But v1's plan only had 6 ACs. v1 mixed stakeholder-visible "definition of done" ACs with implementation-contract ACs in one list because v1's ticket structure had no separate place for implementation contracts. v2's plan has more ACs (11 vs 6) because the v2 generator authored at finer granularity, and v2's ticket structure has a Test-Gen Brief that's specifically designed to hold the implementation-contract content.

So the "33% of ACs lost" number is misleading. What actually happened:

- **v2 plan ACs that are stakeholder-readable** mostly stayed in the AC list.
- **v2 plan ACs that are implementation contracts** got routed into the Test-Gen Brief's Exports / Signatures / Invariants / Tested-by subsections.
- The AC list count dropped because two-thirds of the content moved sections, not because content was dropped.

This is arguably *correct* architecturally — it's the separation the v2 design proposes (stakeholder content in AC; implementation contract in Test-Gen Brief). But there are real things to look at:

1. **Did the routing preserve the content faithfully?** Spot check T8: Plan AC "READY_FOR_JOINT→JOINT_ACTIVE: any party can trigger; idempotent if already JOINT_ACTIVE" maps to which Test-Gen Brief subsection in the ticket? Looking at T8 reviewed: I don't see the idempotency requirement preserved anywhere in the Test-Gen Brief. So *some* content was dropped, just not as much as the AC count suggested. The exact magnitude needs item-by-item checking, not just count comparison.
2. **Is the agent's classification of "stakeholder vs implementation" reliable?** It might mis-route things — moving a stakeholder-relevant requirement into the Test-Gen Brief, or vice versa.
3. **Does the dev-loop downstream consume the Test-Gen Brief as authoritatively as it consumes the AC list?** If the dev-loop reads only ACs and the implementation contracts live in Test-Gen Brief, the dev-loop misses them. (Probably it does read both — but worth confirming.)

**What's actually true and what's actually problematic:**

- The compose-tickets prompt is doing routing work, not just transcription. That's a real architectural choice (whether right or wrong). The "make it deterministic" fix I proposed earlier wouldn't work — the agent is partitioning content, not just dropping it.
- A real fidelity check requires reading each plan AC and asking "does this assertion appear *somewhere* in the ticket (AC, Implementation Notes, or Test-Gen Brief subsection)?" The count-of-bullets check I did was too crude.
- The architecturally interesting question is: is the v2 split (ACs are stakeholder; Test-Gen Brief is contract) the right separation? It might be, and the ticket I read carries substantively richer implementation guidance than v1's WOR-29 did. v2 T8's Tested-by table is more specific than v1's WOR-29's free-form Test-Gen Brief.

The original "deterministic AC rendering" recommendation was the wrong fix. The actual question for mark2 is whether the AC-vs-Test-Gen-Brief split is intentional and correct, and if so, whether the agent's classification is reliable. That's a per-ticket spot-check exercise, not a count-based one.
