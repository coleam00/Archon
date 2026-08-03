# PRD Cookbook

Problem-first, hypothesis-driven product requirements. Interactive multi-round interview that focuses on WHAT and WHY, not HOW.

**Input**: `$ARGUMENTS` — feature idea, problem description, or path to research artifact.

---

## Process Overview

```
INITIATE → FOUNDATION (questions) → GROUNDING (research) → DEEP DIVE (questions) → FEASIBILITY (research) → DECISIONS (questions) → GENERATE
```

Each question set builds on previous answers. Grounding phases validate assumptions with agents.

---

## Phase 1: INITIATE — Confirm Understanding

**If no input provided**, ask:

> **What do you want to build?**
> Describe the product, feature, or capability in a few sentences.

**If input provided**, confirm understanding by restating:

> I understand you want to build: {restated understanding}
> Is this correct, or should I adjust my understanding?

**If input references a research artifact**, read it first and extract context.

**GATE**: Wait for user response before proceeding.

---

## Phase 2: FOUNDATION — Problem Discovery

Present all questions at once (user can answer together):

> **Foundation Questions:**
>
> 1. **Who** has this problem? Be specific — not just "users" but what type of person/role?
> 2. **What** problem are they facing? Describe the observable pain, not the assumed need.
> 3. **Why** can't they solve it today? What alternatives exist and why do they fail?
> 4. **Why now?** What changed that makes this worth building?
> 5. **How** will you know if you solved it? What would success look like?

**GATE**: Wait for user responses before proceeding.

---

## Phase 3: GROUNDING — Market & Context Research

After foundation answers, launch research agents:

### Web Researcher (`web-researcher`)
```
Research the market context for: {product/feature idea}

FIND:
1. Similar products/features in the market
2. How competitors solve this problem
3. Common patterns and anti-patterns
4. Recent trends or changes in this space

Return findings with direct links, key insights, and any gaps.
```

### Codebase Explorer (`Explore`) — if codebase exists
```
Find existing functionality relevant to: {product/feature idea}

LOCATE:
1. Related existing functionality
2. Patterns that could be leveraged
3. Technical constraints or opportunities

Return file locations, code patterns, and conventions observed.
```

**Summarize findings to user:**

> **What I found:**
> - {Market insight 1}
> - {Competitor approach}
> - {Relevant codebase pattern, if applicable}
>
> Does this change or refine your thinking?

**GATE**: Brief pause for user input (can be "continue" or adjustments).

---

## Phase 4: DEEP DIVE — Vision & Users

> **Vision & Users:**
>
> 1. **Vision**: In one sentence, what's the ideal end state if this succeeds wildly?
> 2. **Primary User**: Describe your most important user — their role, context, and what triggers their need.
> 3. **Job to Be Done**: Complete this: "When [situation], I want to [motivation], so I can [outcome]."
> 4. **Non-Users**: Who is explicitly NOT the target? Who should we ignore?
> 5. **Constraints**: What limitations exist? (time, budget, technical, regulatory)

**GATE**: Wait for user responses before proceeding.

---

## Phase 5: FEASIBILITY — Technical Assessment

Launch two agents in parallel if codebase exists:

### Codebase Explorer (`Explore`)
```
Assess technical feasibility for: {product/feature}

LOCATE:
1. Existing infrastructure we can leverage
2. Similar patterns already implemented
3. Integration points and dependencies

Return file locations, code patterns, and conventions.
```

### Codebase Analyst (`codebase-analyst`)
```
Analyze technical constraints for: {product/feature}

TRACE:
1. How existing related features are implemented end-to-end
2. Data flow through potential integration points
3. Architectural patterns and boundaries

Document what exists with precise file:line references. No suggestions.
```

**Summarize to user:**

> **Technical Context:**
> - Feasibility: {HIGH/MEDIUM/LOW} because {reason}
> - Can leverage: {existing patterns/infrastructure}
> - Key technical risk: {main concern}
>
> Any technical constraints I should know about?

**GATE**: Brief pause for user input.

---

## Phase 6: DECISIONS — Scope & Approach

> **Scope & Approach:**
>
> 1. **MVP Definition**: What's the absolute minimum to test if this works?
> 2. **Must Have vs Nice to Have**: What 2-3 things MUST be in v1? What can wait?
> 3. **Key Hypothesis**: Complete this: "We believe [capability] will [solve problem] for [users]. We'll know we're right when [measurable outcome]."
> 4. **Out of Scope**: What are you explicitly NOT building (even if users ask)?
> 5. **Open Questions**: What uncertainties could change the approach?

**GATE**: Wait for user responses before generating.

---

## Phase 7: GENERATE — Write PRD

Save to `.claude/archon/prds/{slug}.prd.md` where `{slug}` is a kebab-case feature name.

Create the directory if it doesn't exist.

### Artifact Template

```markdown
# {Feature Name}

## Problem Statement

{2-3 sentences: Who has what problem, and what's the cost of not solving it?}

## Evidence

- {User quote, data point, or observation that proves this problem exists}
- {Another piece of evidence}
- {If none: "Assumption — needs validation through [method]"}

## Proposed Solution

{One paragraph: What we're building and why this approach over alternatives}

## Key Hypothesis

We believe {capability} will {solve problem} for {users}.
We'll know we're right when {measurable outcome}.

## What We're NOT Building

- {Out of scope item 1} — {why}
- {Out of scope item 2} — {why}

## Success Metrics

| Metric | Target | How Measured |
|--------|--------|--------------|
| {Primary metric} | {Specific number} | {Method} |
| {Secondary metric} | {Specific number} | {Method} |

## Open Questions

- [ ] {Unresolved question 1}
- [ ] {Unresolved question 2}

---

## Users & Context

**Primary User**
- **Who**: {Specific description}
- **Current behavior**: {What they do today}
- **Trigger**: {What moment triggers the need}
- **Success state**: {What "done" looks like}

**Job to Be Done**
When {situation}, I want to {motivation}, so I can {outcome}.

**Non-Users**
{Who this is NOT for and why}

---

## Solution Detail

### Core Capabilities (MoSCoW)

| Priority | Capability | Rationale |
|----------|------------|-----------|
| Must | {Feature} | {Why essential} |
| Must | {Feature} | {Why essential} |
| Should | {Feature} | {Why important but not blocking} |
| Could | {Feature} | {Nice to have} |
| Won't | {Feature} | {Explicitly deferred and why} |

### MVP Scope

{What's the minimum to validate the hypothesis}

### User Flow

{Critical path — shortest journey to value}

---

## Technical Approach

**Feasibility**: {HIGH/MEDIUM/LOW}

**Architecture Notes**
- {Key technical decision and why}
- {Dependency or integration point}

**Technical Risks**

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| {Risk} | {H/M/L} | {How to handle} |

---

## Implementation Phases

<!--
  STATUS: pending | in-progress | complete
  PARALLEL: phases that can run concurrently (e.g., "with 3" or "-")
  DEPENDS: phases that must complete first (e.g., "1, 2" or "-")
-->

| # | Phase | Description | Status | Parallel | Depends | Plan |
|---|-------|-------------|--------|----------|---------|------|
| 1 | {Phase name} | {What this phase delivers} | pending | - | - | - |
| 2 | {Phase name} | {What this phase delivers} | pending | - | 1 | - |
| 3 | {Phase name} | {What this phase delivers} | pending | with 4 | 2 | - |
| 4 | {Phase name} | {What this phase delivers} | pending | with 3 | 2 | - |

### Phase Details

**Phase 1: {Name}**
- **Goal**: {What we're trying to achieve}
- **Scope**: {Bounded deliverables}
- **Success signal**: {How we know it's done}

{Continue for each phase...}

### Parallelism Notes

{Explain which phases can run concurrently and why}

---

## Decisions Log

| Decision | Choice | Alternatives | Rationale |
|----------|--------|--------------|-----------|
| {Decision} | {Choice} | {Options considered} | {Why this one} |

---

## Research Summary

**Market Context**
{Key findings from market research}

**Technical Context**
{Key findings from technical exploration}
```

---

## Phase 8: REPORT — Present and Suggest Next Step

Summarize the PRD in 3-5 bullet points. Link to the artifact.

Present validation status:

| Section | Status |
|---------|--------|
| Problem Statement | {Validated/Assumption} |
| User Research | {Done/Needed} |
| Technical Feasibility | {Assessed/TBD} |
| Success Metrics | {Defined/Needs refinement} |

**Next step**: `/archon-dev plan .claude/archon/prds/{slug}.prd.md`
