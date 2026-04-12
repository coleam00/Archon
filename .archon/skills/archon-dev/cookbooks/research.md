# Research Cookbook

Pure codebase cartography. Documents what IS, not what SHOULD BE. Answer questions about the codebase with evidence.

**Input**: `$ARGUMENTS` — a question about the codebase. Optional: `--follow-up` (append to existing research).

This cookbook is for codebase questions only. For strategic research involving external docs, library comparisons, or feasibility analysis, use the **investigate** cookbook instead.

---

## CRITICAL: Documentarian Only

- **DO NOT** suggest improvements or changes
- **DO NOT** propose future enhancements or critique implementations
- **ONLY** describe what exists, where it exists, how it works, and how components interact

Every claim must have a `file:line` reference. No speculation.

---

## Phase 1: PARSE — Understand the Question

### 1.1 Read Mentioned Files

If the user mentions specific files, read them FULLY first before any decomposition.

### 1.2 Classify the Query

| Type | Indicators | Primary Agent |
|------|-----------|---------------|
| **Where** | "where is", "find", "locate" | `Explore` |
| **How** | "how does", "trace", "flow" | `codebase-analyst` |
| **What** | "what is", "explain", "describe" | Both in parallel |
| **Pattern** | "how do we", "convention", "examples of" | `Explore` |

### 1.3 Determine Scope

- Identify specific components, patterns, or concepts to investigate
- Note `--follow-up` flag for appending to existing research

**CHECKPOINT**: Query classified, scope identified.

---

## Phase 2: DECOMPOSE — Break into Research Areas

Break the query into 2-5 composable research areas:

```
RESEARCH QUESTION: {user's question}

AREAS:
1. {Area} → Agent: {which agent}
2. {Area} → Agent: {which agent}
3. {Area} → Agent: {which agent}
```

Select agents based on query classification. Run in parallel when searching different areas.

---

## Phase 3: EXPLORE — Deploy Parallel Agents

Launch agents in parallel using the Agent tool. Write detailed, specific prompts for each.

### Agent: Codebase Explorer (`Explore`)
**Use for Where/What/Pattern queries.** Ask it to find all relevant code locations — files, functions, types, tests. Request file:line references and actual code snippets.

### Agent: Codebase Analyst (`codebase-analyst`)
**Use for How/What queries.** Ask it to trace data flow, map dependencies, identify entry points, and document how components interact. Request file:line references.

Wait for ALL agents to complete before proceeding.

---

## Phase 4: SYNTHESIZE — Merge Findings

1. **Deduplicate** — Remove overlapping findings across agents
2. **Connect** — Link findings across different components
3. **Answer** — Map findings back to the original question
4. **Identify gaps** — Note areas that couldn't be fully documented
5. **Verify key claims** — Read the most critical files yourself to confirm

---

## Phase 5: WRITE — Create Artifact

### Handle Follow-ups

If `--follow-up` and an existing research file on this topic exists in `.claude/archon/research/`:
1. Read the existing file
2. Append a `## Follow-up: {date}` section
3. Update frontmatter `last_updated`

### New Research

Save to `.claude/archon/research/{date}-{slug}.md`.

Create the directory if it doesn't exist.

### Artifact Template

```markdown
---
date: {ISO timestamp}
git_commit: {short hash}
branch: {branch name}
topic: "{Question/Topic}"
tags: [research, {relevant-component-names}]
status: complete
last_updated: {YYYY-MM-DD}
---

# Research: {topic}

## Question

{The original research question}

## Summary

{2-3 sentence answer — describe what exists, not what should change}

## Detailed Findings

### {Finding Area 1}

**Location**: `{file}:{lines}`

{What exists and how it works}

### {Finding Area 2}

...

## Architecture

{Current patterns, conventions, and design. ASCII diagram if helpful.}

## Code References

| File | Lines | Description |
|------|-------|-------------|
| `{path}` | {range} | {what's there} |

## Open Questions

- {Areas that need further investigation}
```

---

## Phase 6: REPORT — Present to User

Summarize key findings in 3-5 bullet points with `file:line` references. Link to the artifact.

**Next steps**:
- To dig deeper: `/archon-dev research --follow-up {topic}`
- For strategic/external research: `/archon-dev investigate {topic}`
- To write requirements: `/archon-dev prd {topic}`
