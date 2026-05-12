---
description: Autonomously generate Ralph PRD files (prd.md + prd.json) from an idea or existing PRD
argument-hint: <feature idea | path/to/existing-prd.md>
---

# Ralph PRD Generator (Autonomous)

**Input**: $ARGUMENTS
**Workflow ID**: $WORKFLOW_ID

---

## Your Mission

Generate production-quality Ralph PRD files — `prd.md` (full context document) and `prd.json` (story tracking) — through systematic codebase exploration and analysis. No interactive questions — make informed decisions autonomously.

**Core Principle**: CODEBASE FIRST. Explore the project before writing anything. Stories must reference real files, real patterns, and real types.

---

## Phase 0: DETECT — Determine Input Type

| Input Pattern | Type | Action |
|---------------|------|--------|
| Path to `.md` file that exists | Existing PRD | Read it, generate prd.json stories from it |
| `.archon/ralph/{slug}/prd.md` exists | Existing PRD in ralph dir | Generate prd.json alongside it |
| Free-form text | Feature idea | Generate both prd.md and prd.json |
| Empty/blank | Error | STOP — require input |

### If existing PRD detected:

1. Read the PRD file
2. Extract: problem statement, goals, user context, scope limits, technical requirements
3. Skip to Phase 3 (Technical Grounding) — the PRD already covers Phases 1-2

### If feature idea:

1. Store the idea description
2. Proceed through all phases

---

## Phase 1: UNDERSTAND — Problem & Context

**Autonomously determine:**

1. **Problem**: What pain point does this solve? What happens without it?
2. **User**: Who benefits? What's their role and daily workflow?
3. **Goal**: What's the ideal outcome? How will success be measured?
4. **Scope**: What's MVP? What's explicitly out of scope?
5. **Success metrics**: What measurable signals indicate this worked?

Base these on the input description and your understanding of the codebase.

**PHASE_1_CHECKPOINT:**
- [ ] Problem clearly articulated
- [ ] Target user identified
- [ ] Goals and success metrics defined
- [ ] Scope boundaries set

---

## Phase 2: UX & DESIGN — User Journey

**Autonomously determine:**

1. **Trigger**: What event causes the user to need this feature?
2. **Happy path**: Step-by-step user flow from trigger to success
3. **States**: Empty, loading, error, success — what does each look like?
4. **Edge cases**: What can go wrong? How should it be handled?
5. **Interaction model**: CLI commands, API endpoints, UI components?

If the feature has a UI component, describe the visual requirements.
If it's backend-only, describe the API surface.

**PHASE_2_CHECKPOINT:**
- [ ] User journey mapped
- [ ] States enumerated
- [ ] Edge cases identified

---

## Phase 3: TECHNICAL GROUNDING — Codebase Exploration

**This is the critical phase.** Use the Task tool with `subagent_type="Explore"` to systematically explore the codebase.

### 3.1 Find Similar Implementations

```
Explore the codebase for patterns relevant to: {feature description}

FIND:
1. Similar implementations to mirror (with file:line references)
2. Existing types/interfaces to extend or use
3. Naming conventions (functions, files, variables)
4. Error handling patterns
5. Test patterns (framework, structure, assertion style)
6. Database schema patterns (if applicable)
7. Component patterns (if UI involved)
```

### 3.2 Identify Integration Points

```
Trace data flow and entry points for: {feature description}

FIND:
1. Where new code connects to existing code
2. Which modules/packages are affected
3. Import patterns to follow
4. Config/env dependencies
```

### 3.3 Read Project Rules

```bash
cat CLAUDE.md
```

Extract: coding standards, naming conventions, testing requirements, lint rules.

**PHASE_3_CHECKPOINT:**
- [ ] Similar implementations found with file:line references
- [ ] Types and interfaces identified
- [ ] Integration points mapped
- [ ] CLAUDE.md rules noted

---

## Phase 4: STORY BREAKDOWN — Split Into Iterations

### 4.1 Identify Layers

Break the feature into implementation layers:

| Layer | Examples | Typical story count |
|-------|---------|-------------------|
| Schema/types | DB columns, interfaces, Zod schemas | 1-2 |
| Backend logic | Services, utilities, API endpoints | 2-4 |
| UI components | New components, modifications | 1-3 |
| Integration | Wiring, config, exports | 1-2 |
| Tests | Dedicated test stories (if complex) | 0-2 |

### 4.2 Sizing Rules

Each story must be completable in ONE iteration (~15-30 min of AI work):

**Right-sized (ONE iteration):**
- Add a database column + migration
- Create one utility function + tests
- Add one UI component
- Update one API endpoint + tests
- Write integration tests for one feature

**TOO BIG (must split):**
- "Build entire feature" → split into schema, types, backend, UI
- "Add authentication" → split into schema, middleware, login UI, token handling
- "Refactor module" → split by file or concern

### 4.3 Dependency Ordering

- Stories ordered by dependency (lower priority = runs first)
- Schema before types before backend before UI before integration
- `dependsOn` must only reference lower-priority stories
- Validate: no circular dependencies, no forward references

### 4.4 Acceptance Criteria Rules

**GOOD (verifiable):**
- "Add `priority` column with type `'high' | 'medium' | 'low'`"
- "Function returns empty array when input is null"
- "Button shows loading state while submitting"
- "Type-check passes with zero errors"

**BAD (vague):**
- "Works correctly"
- "Good UX"
- "Handles edge cases"

Every criterion must be pass/fail testable.

**PHASE_4_CHECKPOINT:**
- [ ] Stories sized for single iterations
- [ ] Dependencies form a valid DAG (no cycles)
- [ ] Acceptance criteria are all verifiable
- [ ] Technical notes reference real files and patterns

---

## Phase 5: GENERATE — Write PRD Files

### 5.1 Determine Feature Slug

Generate a kebab-case slug from the feature name:
- "Workflow Lifecycle Overhaul" → `workflow-lifecycle-overhaul`
- "Dark Mode Toggle" → `dark-mode-toggle`
- Max 50 characters

### 5.2 Create Directory

```bash
mkdir -p .archon/ralph/{slug}
```

### 5.3 Write prd.md

**Output path**: `.archon/ralph/{slug}/prd.md`

Include ALL of the following sections:

```markdown
# {Feature Name} — Product Requirements

## Overview

**Problem**: {What pain this solves — from Phase 1}
**Solution**: {What we're building}
**Branch**: `ralph/{slug}`

---

## Goals & Success

### Primary Goal
{The main outcome}

### Success Metrics
| Metric | Target | How Measured |
|--------|--------|--------------|
| {metric} | {target} | {method} |

### Non-Goals (Out of Scope)
- {Item 1} — {why excluded}
- {Item 2} — {why excluded}

---

## User & Context

### Target User
- **Who**: {description}
- **Role**: {their context}
- **Current Pain**: {what they struggle with}

### User Journey
1. **Trigger**: {what prompts the need}
2. **Action**: {what they do}
3. **Outcome**: {success state}

---

## UX Requirements

### Interaction Model
{How users interact — CLI commands, API endpoints, UI components}

### States to Handle
| State | Description | Behavior |
|-------|-------------|----------|
| Empty | {when} | {what happens} |
| Loading | {when} | {what happens} |
| Error | {when} | {what happens} |
| Success | {when} | {what happens} |

---

## Technical Context

### Patterns to Follow
- **Similar implementation**: `{file:lines}` — {what to mirror}
- **Component pattern**: `{file:lines}` — {pattern description}
- **Test pattern**: `{file:lines}` — {how to test}

### Types & Interfaces
```typescript
// Key types to use or extend
{relevant type definitions from codebase exploration}
```

### Architecture Notes
- {Key technical decisions}
- {Integration points from Phase 3}
- {Dependencies}

---

## Implementation Summary

### Story Overview
| ID | Title | Priority | Dependencies |
|----|-------|----------|--------------|
| US-001 | {title} | 1 | — |
| US-002 | {title} | 2 | US-001 |

### Dependency Graph
```
US-001 (schema/types)
    ↓
US-002 (backend)
    ↓
US-003 (UI) → US-004 (integration)
```

---

## Validation Requirements

Every story must pass:
- [ ] Type-check: `bun run type-check`
- [ ] Lint: `bun run lint`
- [ ] Tests: `bun run test`
- [ ] Format: `bun run format:check`

---

*Generated: {ISO timestamp}*
```

**If input was an existing PRD**: Incorporate its content into this structure. Don't lose information — merge the existing PRD's goals, context, and requirements into the appropriate sections. Add the technical context from your codebase exploration (Phase 3).

### 5.4 Write prd.json

**Output path**: `.archon/ralph/{slug}/prd.json`

```json
{
  "project": "{ProjectName}",
  "branchName": "ralph/{slug}",
  "prdFile": "prd.md",
  "description": "{One line summary}",
  "userStories": [
    {
      "id": "US-001",
      "title": "{Short title}",
      "description": "As a {user}, I want {capability} so that {benefit}",
      "acceptanceCriteria": [
        "{Specific verifiable criterion 1}",
        "{Specific verifiable criterion 2}",
        "Type-check passes",
        "Tests pass"
      ],
      "technicalNotes": "{Files to modify, patterns to follow, types to use — from Phase 3}",
      "dependsOn": [],
      "priority": 1,
      "passes": false,
      "notes": ""
    }
  ]
}
```

### 5.5 Commit PRD Files

```bash
git add .archon/ralph/{slug}/
git commit -m "docs: add Ralph PRD for {feature name}"
```

**PHASE_5_CHECKPOINT:**
- [ ] `.archon/ralph/{slug}/prd.md` written with all sections
- [ ] `.archon/ralph/{slug}/prd.json` written with properly sized stories
- [ ] Stories have verifiable acceptance criteria
- [ ] Technical notes reference real files from codebase exploration
- [ ] Files committed

---

## Phase 6: OUTPUT — Report

```
PRD_DIR=.archon/ralph/{slug}
STORIES_TOTAL={count}
FILES_CREATED=prd.md,prd.json

## Ralph PRD Ready

**Feature**: {name}
**Directory**: `.archon/ralph/{slug}/`
**Stories**: {count} user stories
**Dependencies**: Valid DAG (no cycles)

| # | ID | Title | Dependencies |
|---|-----|-------|--------------|
| 1 | US-001 | {title} | — |
| 2 | US-002 | {title} | US-001 |
```

---

## Success Criteria

- **CONTEXT_COMPLETE**: prd.md has goals, user context, UX, technical patterns from real codebase exploration
- **STORIES_SIZED**: Each story completable in one iteration
- **DEPENDENCIES_VALID**: No circular dependencies, lower priority runs first
- **CRITERIA_VERIFIABLE**: All acceptance criteria are pass/fail testable
- **TECHNICAL_GROUNDED**: Technical notes reference real files, types, and patterns from the codebase
- **FILES_WRITTEN**: Both prd.md and prd.json exist in `.archon/ralph/{slug}/`
