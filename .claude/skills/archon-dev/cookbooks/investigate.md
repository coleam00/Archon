# Investigate Cookbook

Strategic research combining external knowledge with codebase feasibility. Answers "what should we do?" questions by researching options, comparing approaches, and assessing how they'd fit into the existing codebase.

**Input**: `$ARGUMENTS` — a question, technology choice, or approach to evaluate.

Use this cookbook when the question goes beyond "how does our code work" into:
- **Library/tool evaluation**: "Should we use X or Y?"
- **Approach research**: "What's the best way to add WebSocket support?"
- **Feasibility assessment**: "Can we migrate from SQLite to Turso?"
- **Prior art**: "How do other projects handle rate limiting?"
- **Integration planning**: "What would it take to add OpenTelemetry?"

For pure codebase questions ("how does X work?"), use the **research** cookbook instead.

---

## Phase 1: FRAME — Define the Question

Parse `$ARGUMENTS` and classify:

| Type | Example | Focus |
|------|---------|-------|
| **Compare** | "X vs Y for our use case" | Side-by-side evaluation with codebase fit |
| **Explore** | "Best way to add Z" | Survey approaches, recommend one |
| **Feasibility** | "Can we do X?" | Technical constraints, effort, risks |
| **Prior art** | "How do others handle X?" | External patterns + applicability to us |

Restate the question clearly:

```
QUESTION: {restated question}
TYPE: {Compare / Explore / Feasibility / Prior Art}
DECISION NEEDED: {what the user needs to decide after reading this}
```

**CHECKPOINT**: Question framed. Decision point identified.

---

## Phase 2: DISCOVER — Parallel Research

Launch 2-3 agents in parallel:

### Agent 1: Web Researcher (`web-researcher`)
**Always launch.** Write a detailed prompt:

```
Research: {the question}

FIND:
1. Current best practices and recommended approaches
2. Comparison of options (if applicable) with pros/cons
3. Official documentation for relevant libraries (match versions if known)
4. Known gotchas, performance characteristics, maintenance status
5. Real-world usage examples and case studies

Return findings with direct links to specific doc sections (not homepages).
Flag anything that's version-sensitive or recently changed.
```

### Agent 2: Codebase Explorer (`Explore`)
**Always launch.** Write a detailed prompt:

```
Find everything in our codebase relevant to: {the question}

LOCATE:
1. Existing infrastructure that relates to this decision
2. Current patterns and conventions we'd need to align with
3. Dependencies already in use that overlap or conflict
4. Configuration, types, and integration points that would be affected

Return file:line references and actual code snippets.
```

### Agent 3: Codebase Analyst (`codebase-analyst`)
**Launch for feasibility/integration questions.** Write a detailed prompt:

```
Analyze how {the topic} would integrate with our existing architecture.

TRACE:
1. Entry points where new code would connect
2. Data flow through affected components
3. Contracts and interfaces that constrain the approach
4. Side effects and state that would be impacted

Document what exists with file:line references. No suggestions — just map the landscape.
```

---

## Phase 3: ASSESS — Evaluate Fit

After agents return, assess each option against the codebase:

### For each option/approach:

**Codebase Alignment**
- Does it match our existing patterns? Which ones?
- Does it conflict with anything? What would need to change?
- What dependencies does it share with or add to our stack?

**Integration Effort**
- What files would need to change?
- How invasive is the change? (surface-level adapter vs deep refactor)
- Can it be adopted incrementally or is it all-or-nothing?

**Trade-offs**

| Dimension | Option A | Option B |
|-----------|----------|----------|
| Codebase fit | {how well it aligns} | {how well it aligns} |
| Learning curve | {for this team/project} | {for this team/project} |
| Maintenance | {community, updates} | {community, updates} |
| Performance | {relevant characteristics} | {relevant characteristics} |
| Migration path | {effort to adopt} | {effort to adopt} |

---

## Phase 4: RECOMMEND — Form Opinion

Unlike the research cookbook, this cookbook SHOULD form an opinion.

State a clear recommendation with reasoning:

```
RECOMMENDATION: {Option/approach}
CONFIDENCE: {High/Medium/Low}
REASONING: {2-3 sentences — why this over alternatives, grounded in codebase evidence}
```

If no clear winner exists, say so and explain what additional information would tip the decision.

---

## Phase 5: WRITE — Save Artifact

Save to `.claude/archon/research/{date}-{slug}.md`.

Create the directory if it doesn't exist.

### Artifact Template

```markdown
---
date: {ISO timestamp}
topic: "{Question}"
type: {compare / explore / feasibility / prior-art}
tags: [investigate, {relevant topics}]
status: complete
recommendation: "{short recommendation}"
---

# Investigation: {Question}

## Decision Needed

{What the user needs to decide after reading this}

## Summary

{3-4 sentence overview of findings and recommendation}

## Current State

{What exists in our codebase today that's relevant — with file:line refs}

## Research Findings

### {Option/Approach A}

**What it is**: {brief description}
**Source**: {links to docs, articles}

**Pros**:
- {pro with evidence}

**Cons**:
- {con with evidence}

**Codebase fit**: {how it aligns with our patterns — file:line refs}

### {Option/Approach B}

...

## Comparison

| Dimension | {Option A} | {Option B} |
|-----------|-----------|-----------|
| Codebase fit | {assessment} | {assessment} |
| Integration effort | {LOW/MED/HIGH} | {LOW/MED/HIGH} |
| Learning curve | {assessment} | {assessment} |
| Maintenance outlook | {assessment} | {assessment} |

## Integration Analysis

{How the recommended approach would connect to existing code}

**Affected areas**:

| File/Area | Impact | Notes |
|-----------|--------|-------|
| `{path}` | {what changes} | {details} |

**Constraints**:
- {architectural constraint from codebase}
- {dependency constraint}

## Recommendation

**{Option/Approach}** — Confidence: {High/Medium/Low}

{Why this option, grounded in both external research and codebase evidence.
What makes it the best fit for THIS project specifically.}

## Next Steps

{Concrete actions to move forward with the recommendation}

## Open Questions

- {Anything that could change the recommendation}
```

---

## Phase 6: REPORT — Present to User

Summarize:
- The question and what was researched
- Top 2-3 findings from external research
- How options fit (or don't) with the codebase
- Clear recommendation with confidence level

Link to the artifact.

**Next steps**:
- To write requirements: `/archon-dev prd {recommended approach}`
- To plan implementation: `/archon-dev plan {recommended approach}`
- For deeper codebase context: `/archon-dev research {specific component}`
