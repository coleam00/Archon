---
description: Research codebase and propose scope and approach for Work Order creation
---

# Scope & Approach — Work Order Planning

**Original idea**: $ARGUMENTS

**Foundation answers from user**:
$foundation-gate.output

---

## Your Role

You are researching the codebase to propose a concrete scope and implementation approach
before Work Orders are created. Think from first principles — what already exists?

---

## Phase 1: DEEP CODEBASE EXPLORATION

**CRITICAL**: Read actual files. Do not guess or assume. Use CGC (CodeGraphContext)
via Neo4j when available for graph-based codebase exploration — it provides
dependency graphs, call chains, and structural relationships that file search alone misses.

**CGC queries to run** (if CGC/Neo4j MCP is available):
- Find all modules that import/export types related to the idea
- Trace call chains from entry points to the affected code
- Map dependency relationships between files that will change

**Fallback** (if CGC is not available): Use Task tool with subagent_type="Explore":

```
Explore the codebase for patterns relevant to implementing: {idea from $ARGUMENTS}

FIND:
1. Existing implementations that overlap with the idea (file:line references)
2. Types, interfaces, and schemas that would be affected
3. Test files that cover related functionality
4. Integration points — where new code will connect to existing
5. Recent git history in affected areas: git log --oneline -15 -- {relevant path}
```

---

## Phase 2: FIRST-PRINCIPLES INVENTORY

Before proposing anything new, document what already exists:

**What Already Exists (verified by reading code):**

| Primitive | File:Lines | What It Does | Relevance |
|-----------|-----------|--------------|-----------|
| {name} | `path/to/file.ts:N-M` | {description} | {extend / replace / integrate} |

**What the Smallest Change Looks Like:**
- Prefer extending existing files over creating new ones
- Prefer using existing types and interfaces over defining new ones
- Note which existing tests cover the affected code

---

## Phase 3: PROPOSE SCOPE & APPROACH

Present a summary to the user:

```
## Proposed Scope

**What We're Building:**
{2-3 sentence description of exactly what changes}

**What Already Exists:**
- `{file:line}` — {what it does and how it relates}

**Approach:**
{THE recommended approach — the one that fits the codebase best}

**Alternative Considered:**
{One rejected alternative and why}

**Explicit Out of Scope:**
- {thing we are NOT building and why}

**Files That Will Change:**
| File | Action | Why |
|------|--------|-----|
| `path/to/file.ts` | CREATE / UPDATE | {reason} |

**Estimated Work Orders:**
{N} — {brief description of each}
```

Ask the user: "Does this scope and approach look right? Any corrections before I break it into phases?"
