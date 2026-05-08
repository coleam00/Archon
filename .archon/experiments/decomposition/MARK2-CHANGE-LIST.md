# Mark2 Change List

Specific, evidenced changes to make to `v2-epic-decomposition-mark1.yaml` and its supporting prompts before running mark2. Each change is tied to a concrete observation from the mark1 run.

Mark2 is still about decomposition only — same input shape (epic + attachments → tickets as files), same scope. Improvements are within that scope; nothing outside it.

---

## Architectural changes

### 1. Stack rules and design rules live IN the plan, not as sidecar docs

**Mark1 evidence:** Of 9 backend tasks that author Convex mutations/queries/actions, only 1 (T17) had `convex-test` in its `stack_practices` field. The fragmented per-task framing under-attended to specifics. Asked the canonical question directly, Claude names convex-test in the first sentence.

**Wrong shape considered earlier:** sidecar `stack-rules.md` + `design-rules.md` documents. Rejected — the plan is supposed to be THE canonical artifact for the project. Splitting it across multiple files makes downstream consumption fragile and the rules document set unbounded.

**Change:** The plan grows two top-level sections — `stack_rules` and `design_rules` — alongside `phases` and `tasks`. The plan-builder authors phases and tasks. The stack adviser pass mutates the plan to add `stack_rules`. The design adviser pass mutates the plan to add `design_rules`. One artifact, multiple authors, each adding their section.

Plan shape (after all enrichment passes):

```json
{
  "epic_title": "...",
  "planning_assumptions": [...],
  "stack_rules": {
    "convex": "...markdown...",
    "react": "...markdown...",
    "tailwind": "...markdown...",
    "vitest": "...markdown...",
    "playwright": "...markdown..."
  },
  "design_rules": {
    "tokens": "...markdown...",
    "typography": "...markdown...",
    "component_patterns": "...markdown...",
    "accessibility": "...markdown..."
  },
  "phases": [
    { "phase_id": "P1", "goal": "...", "tasks": [{ "task_id": "T1", ... }, ...] },
    ...
  ]
}
```

Compose-tickets reads the plan and has everything it needs: the task entry, the phase context, the stack rules, the design rules. No separate file resolution. No risk of the rules getting out of sync with the plan version.

### 2. Stack adviser pass: prompt shape and authoring contract

**Change:** The stack adviser is asked the canonical question and writes its output into `plan.stack_rules`:

> You are a senior engineering adviser. This project uses [stack list inferred from the spec]. For each technology, write guidelines covering testing patterns, naming conventions, common pitfalls, and architectural conventions. Surface implied dependencies — packages typically installed alongside the named ones. Write your output as the `stack_rules` field of the plan: a JSON object whose keys are technology names and whose values are markdown strings authoritative for that technology.

The adviser does not read or modify any per-task content. It reads the plan's `epic_title` and `planning_assumptions` (and the spec attachments) and writes `stack_rules`.

### 3. Design adviser pass: same shape, writes to `plan.design_rules`

**Change:** Same pattern as the stack adviser, scoped to design language and UI:

> You are a senior product designer with deep expertise in this project's design system. Read the design doc and style guide. For each major design concern (tokens, typography, component patterns, accessibility, motion, layout), write authoritative guidelines. Write your output as the `design_rules` field of the plan: a JSON object whose keys are design concerns and whose values are markdown strings.

### 4. Compose-tickets reads the plan and applies relevant rules per ticket

**Change:** Compose-tickets reads `plan-final-enriched.json` (the plan after all enrichment passes have written their sections). For each ticket, the agent consults `stack_rules` and `design_rules` and applies the relevant subsections to the ticket's Test-Gen Brief Contract section (and Implementation Notes where appropriate).

The `## Stack Practices` and `## Design Practices` top-level sections are removed from the ticket schema. The relevant content lives inside the Test-Gen Brief's Contract where it's actionable, alongside the symbols and signatures.

### 4. AC verbatim preservation in the AC section

**Mark1 evidence:** The compose-tickets prompt said "bulleted list of T.acceptance_criteria. Verbatim from the plan." The agent still consolidated ACs because v2's Test-Gen Brief structure (Exports, Signatures, Invariants, Non-goals as required subsections) gave it a place to *route* implementation-contract ACs. T8 plan: 11 ACs. T8 ticket AC list: 3 rolled-up ACs. Idempotency requirement (the WOR-89 bug class) was lost entirely — not preserved in either AC or Test-Gen Brief.

**Change:** The AC instruction is unambiguous about what stays where:

> `## Acceptance Criteria` — bulleted list of `T.acceptance_criteria`. **Render every AC verbatim. Do not consolidate, summarize, rephrase, or relocate any AC into other sections. The Test-Gen Brief expands on these ACs by mapping each one to test plan; it does not replace them.**

And a phase checkpoint after step 3 verifies AC count matches:

> Checkpoint: count the bullets in your AC section and verify the count equals `T.acceptance_criteria.length`. If not, you have consolidated or dropped ACs. Restore them.

### 5. Test-Gen Brief restructured: Contract + Test Plan, with explicit per-AC mapping

**Mark1 evidence:** The current Test-Gen Brief has Files / Exports / Signatures / Queries used / Invariants / Non-goals / Tested by as flat subsections. The "Tested by" subsection sometimes references ACs by name ("AC1: ..."), sometimes doesn't. T8 lost ACs in routing because the prompt allowed implementation-contract ACs to "live" in Invariants instead of staying at the top level.

**Change:** Test-Gen Brief is split into two clearly-labeled subsections:

> `## Test-Gen Brief`
>
> ### Contract
> The shared vocabulary the test writer and code writer both consume. Author from the plan + `stack-rules.md` + attachments.
> - **Files** — full paths where exports live; full paths where tests live.
> - **Exports** — every public symbol the implementation must expose, named, with shape (named/default, value/type).
> - **Signatures** — exact TypeScript declarations for each export.
> - **Queries used** — API references called by the implementation.
> - **Invariants** — properties that must hold regardless of input.
> - **Non-goals** — explicit scope fence.
>
> ### Test Plan
> One row per AC from the section above. Every AC must appear here.
> | AC | Layer | What to assert | Fixtures / mocks |
> |----|-------|----------------|------------------|
> | AC1 (verbatim AC text or first 60 chars) | unit / integration / e2e | specific assertion shape, referencing Contract symbols by name | what fixtures or mocks are needed |
> | AC2 ... |  |  |  |

A phase checkpoint verifies every AC has exactly one row:

> Checkpoint: the Test Plan table has the same number of rows as the AC section has bullets. Each row's "AC" column references an AC bullet by its content. Confirm and restore any missing rows before proceeding.

### 6. AST is phased — `phases: [...]` as outer container

**Mark1 evidence:** v1 plan and v2 mark1 plan are both flat task lists. WOR-5's PRD §9 Release Plan literally says Phase 0 — Spec & Foundations, Phase 1 — Core Flow, etc. Neither plan captured those phases as first-class structure. Phases are how a compiler breaks down a large translation; the decomposer needs the same shape.

**Change:** The plan-builder authors a phased plan:

```json
{
  "epic_title": "...",
  "planning_assumptions": [...],
  "phases": [
    {
      "phase_id": "P1",
      "goal": "Foundation: scaffolding, schema, auth, infra ready for feature work",
      "tasks": [
        { "task_id": "T1", ... },
        { "task_id": "T2", ... },
        ...
      ]
    },
    ...
  ]
}
```

Cross-phase dependencies are implicit from phase ordering. Within a phase, tasks declare `depends_on` for in-phase ordering. The plan-builder thinks "what are the phases" before "what are the tickets within each phase."

### 7. Eliminate standalone test tickets

**Mark1 evidence:** v2 mark1 plan has T34 (Playwright E2E test suite — collapsed v1's 7 separate E2E tickets into one) and T35 (Vitest unit tests for core utility modules). Both are wrong-shape; tests are produced by the test-gen agent as part of each feature's pipeline, not as separate work units. v1 had 8 such tickets; v2 mark1 has 2. Mark2 should have 0.

**Change:** Add an explicit rule to the plan-builder prompt:

> Do not author standalone "test" tasks. Tests are produced as part of each feature's pipeline by the test-gen agent. Every feature task carries its testing requirements in its acceptance_criteria; the downstream pipeline authors the tests against those ACs. The only exception is initial test infrastructure (e.g., `playwright.config.ts`, `vitest.config.ts`, CI test runners) which is part of the scaffolding phase.

Add a checkpoint in the adversarial evaluator: "no task is purely a 'tests for X' or 'test suite for Y' task. All testing requirements live in feature tasks' ACs."

---

## Prompt format conformance

### 8. Every prompt follows the LOAD → PROCESS → GENERATE → COMMIT → REPORT template

**Mark1 evidence:** The current prompts are loose mission statements ("Build a task decomposition plan for this Epic. Inputs: ... Rules: ..."). No phase boundaries. No checkpoints. No deterministic verification points.

**Change:** Every prompt — the four sequential nodes (adversarial generator, adversarial evaluator, stack adviser, design adviser) and the three loop prompts (adversarial loop, compose-tickets, review-and-improve) — gets retemplated into:

- **Phase 1: LOAD** — list every input artifact by absolute path. End with explicit checkpoint listing each artifact and a verification action ("confirm exists, non-empty, parseable").
- **Phase 2: PROCESS** — one central, well-shaped question; the work happens here. End with a checkpoint that the agent can answer yes/no about its own state.
- **Phase 3: GENERATE** — name the exact output artifact path and shape. Render content per the prompt structure.
- **Phase 4: COMMIT** — verify the artifact is on disk, non-empty, schema-valid where applicable.
- **Phase 5: REPORT** — return a structured pointer or summary the next stage can consume.

Checkpoints are real verification, not vibes. "Count AC bullets and verify == plan AC count" is a checkpoint. "Make sure your output is good" is not.

### 9. Each prompt asks one well-shaped central question

**Mark1 evidence:** The convex-test discovery — when Claude is asked the canonical question ("how do you test a Convex project?") it answers fully. When asked many small per-task decisions, attention fragments. Every prompt's PROCESS phase should be structured around one such question.

**Change:** For each prompt, identify and state the central question explicitly at the start of PROCESS:

- Plan-builder: "Decompose this PRD into phased tasks. What are the phases, and within each phase, what are the smallest cohesive cuts?"
- Plan evaluator: "What are the substantive flaws in this plan that would cause downstream defects?"
- Stack adviser: "How should a project using this tech stack be set up and tested?"
- Design adviser: "How should a UI implemented to this design system be authored, tested, and made accessible?"
- Compose-tickets (per iteration): "Given this single task and the project's rules, write a ticket that contains every AC verbatim plus a contract and per-AC test plan that nails down the shared vocabulary."
- Review-and-improve (per iteration): "Read this ticket against the plan and the rules. What concrete improvements would tighten symbol naming, fill TBDs, or strengthen the per-AC test plan? Apply them."

### 10. Prompt files extracted where possible

**Mark1 evidence:** The four sequential AI nodes (stack-expert, design-expert, plus the adversarial generator and evaluator roles within the loop) are inline in the YAML. The two adviser prompts can move to command files; the adversarial loop's two roles stay inline because loop nodes can't reference command files yet.

**Change:**
- Extract `stack-adviser-pass` → `archon-v2-stack-adviser.md` (command file). It reads the plan + attachments, mutates the plan to add `stack_rules`.
- Extract `design-adviser-pass` → `archon-v2-design-adviser.md` (command file). It reads the plan + attachments, mutates the plan to add `design_rules`.
- Adversarial generator and evaluator stay inline (in the loop's prompt with state-driven role dispatch).
- Compose-tickets prompt stays inline (loop node).
- Review-and-improve prompt stays inline (loop node).

Inline prompts get the same template treatment; the YAML around them is just packaging. The extracted prompts have an additional benefit: they're inspectable and editable as standalone files, and lint-checkable for template conformance.

---

## Quality gates / checkpoints

### 11. Adversarial evaluator scores at phase level + task level

**Mark1 evidence:** The evaluator scored across 5 dimensions (coverage, sizing, dependencies, testability, scope_fences) on the whole plan. With phasing, the evaluator should score each phase against the same dimensions, then score cross-phase coherence separately.

**Change:** Evaluator's scoring shape:

```json
{
  "phase_scores": [
    { "phase_id": "P1", "scores": { "coverage": 8, "sizing": 9, "dependencies": 9, "testability": 8 } },
    ...
  ],
  "cross_phase_scores": { "ordering": 9, "boundary_clarity": 8, "transition_gates": 7 },
  "passed": ...,
  "objections": [...]
}
```

### 12. Pass threshold review

**Mark1 evidence:** Threshold of 8/10 across 5 dimensions converged in 3 rounds with substantive objections. Round 2's 3 objections (closureProposalSummary in schema, users/updateDisplayName signature precision, sendUserMessage @-mention parameter) were minor wording; the threshold may be set right.

**Change:** Keep threshold at 8/10. Re-evaluate after a couple of mark2 runs.

### 13. Plan-builder explicit verification: every PRD user story → ≥1 task

**Mark1 evidence:** The mark1 evaluator caught coverage gaps post-hoc. Better to have the generator self-verify before submitting to the evaluator.

**Change:** Plan-builder's PROCESS phase ends with a checkpoint:

> Checkpoint: enumerate every user story (US-XX) and named NFR from the PRD. For each, identify which task(s) implement it. If any user story has no task or any NFR has no task carrying it as an AC, restore the plan before proceeding.

---

## Out of scope for mark2

These are real but defer:

- The unified-AI-invocation refactor (would let loop nodes use commands; we keep loop prompts inline for mark2).
- The dispatcher/policies architecture (cage-by-rules, dispatcher hook). Doesn't affect decomposition.
- Per-iteration prompt injection (engine-side role dispatch). v3.
- The "team" abstraction. v3.
- Applying the format/template discipline to ALL Archon prompts (we apply it to the v2 mark2 prompts only for now; broader migration follows).

---

## Sequence of changes

1. Write the new `archon-v2-stack-adviser.md` and `archon-v2-design-adviser.md` command files. Each one mutates the plan in place (adds its `stack_rules` or `design_rules` section and writes the plan back).
2. Rewrite the inline adversarial loop prompt with state-driven role dispatch + phase-aware generator + phased evaluator. Output is a phased plan (`phases:` outer container).
3. Rewrite the inline compose-tickets prompt with the new ticket structure (verbatim ACs, restructured Test-Gen Brief with explicit Contract + Test Plan subsections, no top-level Stack/Design Practices, checkpoints with count verification).
4. Rewrite the inline review-and-improve prompt to enforce AC-count fidelity and per-AC test plan rows.
5. Update the workflow YAML: the advisers mutate the plan; compose-tickets reads only the plan (no sidecar files).
6. Validate the workflow.
7. Run on `_inputs/wor-5`.
8. Compare mark2 outputs against mark1 outputs and against the v1 Jira tickets.

That's the staging. Mark2 is bounded; we ship it as one coherent set of changes and evaluate on the same Epic.
