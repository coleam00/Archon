# Ralph PRD Generator

**Input**: $ARGUMENTS

---

## Your Role

You are creating a PRD for the Ralph autonomous loop. You generate TWO files:
1. `prd.md` - Full context document (goals, persona, UX, success criteria)
2. `prd.json` - Story tracking with passes/fails

Each Ralph iteration receives the FULL prd.md context plus its specific story from prd.json.

**Critical Rules:**
- Each story must be completable in ONE iteration
- Stories ordered by dependency (schema → backend → UI)
- Acceptance criteria must be VERIFIABLE (not vague)

---

## Phase 1: INITIATE

**If no input provided**, ask:

> **What do you want to build?**
> Describe the feature or capability in a few sentences.

**If input provided**, confirm:

> I understand you want to build: {restated understanding}
> Is this correct?

**GATE**: Wait for confirmation.

---

## Phase 2: FOUNDATION

Ask these questions together:

> **Foundation Questions:**
>
> 1. **Problem**: What pain point does this solve? What happens if we don't build it?
>
> 2. **User**: Who is this for? Describe their role and context.
>
> 3. **Goal**: What's the ideal outcome if this succeeds?
>
> 4. **Scope**: MVP or full implementation? What's explicitly out of scope?
>
> 5. **Success**: How will we measure if this worked? What metrics matter?

**GATE**: Wait for answers.

---

## Phase 3: UX & DESIGN

Ask:

> **UX Questions:**
>
> 1. **User Journey**: What triggers the user to need this? What's the happy path?
>
> 2. **UI Requirements**: Any specific visual requirements? Colors, placement, components?
>
> 3. **Interaction Model**: How does the user interact? Clicks, keyboard, API?
>
> 4. **Edge Cases**: What error states need handling? Empty states?
>
> 5. **Accessibility**: Any a11y requirements?

**GATE**: Wait for answers.

---

## Phase 4: TECHNICAL GROUNDING

**Use Explore agent:**

```
Explore the codebase for patterns relevant to: {feature}

FIND:
1. Similar implementations to mirror (with file:line references)
2. Existing types/interfaces to extend
3. Component patterns to follow
4. Test patterns used
5. Database schema patterns
```

**Summarize:**

> **Technical Context:**
> - Similar pattern: {file:lines}
> - Types to extend: {types}
> - Components to use: {components}
> - Test pattern: {pattern}
>
> Any additional technical constraints?

**GATE**: Brief pause for input.

---

## Phase 5: STORY BREAKDOWN

Ask:

> **Story Planning:**
>
> 1. **Database**: Schema changes needed? New tables/columns?
>
> 2. **Types**: New interfaces or type extensions?
>
> 3. **Backend**: Server logic, API endpoints, services?
>
> 4. **UI Components**: New components or modifications?
>
> 5. **Integration**: How do pieces connect?

**GATE**: Wait for answers.

---

## Phase 6: GENERATE FILES

**Naming Convention**: Use the feature name as a kebab-case slug.
- Feature: "User Authentication" → slug: `user-authentication`
- Feature: "Dark Mode Toggle" → slug: `dark-mode-toggle`

**First**, create the ralph directory for this feature:
```bash
# Replace {feature-slug} with the actual kebab-case feature name
mkdir -p .archon/ralph/{feature-slug}
```

### File 1: prd.md

**Output path**: `.archon/ralph/{feature-slug}/prd.md`

```markdown
# {Feature Name} - Product Requirements

## Overview

**Problem**: {What pain this solves}
**Solution**: {What we're building}
**Branch**: `ralph/{feature-kebab}`

---

## Goals & Success

### Primary Goal
{The main outcome we want}

### Success Metrics
| Metric | Target | How Measured |
|--------|--------|--------------|
| {metric} | {target} | {method} |

### Non-Goals (Out of Scope)
- {Item 1} - {why excluded}
- {Item 2} - {why excluded}

---

## User & Context

### Target User
- **Who**: {Specific description}
- **Role**: {Their job/context}
- **Current Pain**: {What they struggle with today}

### User Journey
1. **Trigger**: {What prompts the need}
2. **Action**: {What they do}
3. **Outcome**: {What success looks like}

### Jobs to Be Done
When {situation}, I want to {motivation}, so I can {outcome}.

---

## UX Requirements

### Visual Design
- {Color/style requirements}
- {Component preferences}
- {Layout requirements}

### Interaction Model
- {How users interact}
- {Keyboard shortcuts if any}
- {Mobile considerations}

### States to Handle
| State | Description | UI Behavior |
|-------|-------------|-------------|
| Empty | {when} | {show what} |
| Loading | {when} | {show what} |
| Error | {when} | {show what} |
| Success | {when} | {show what} |

### Accessibility
- {A11y requirements}

---

## Technical Context

### Patterns to Follow
- **Similar implementation**: `{file:lines}` - {what to mirror}
- **Component pattern**: `{file:lines}` - {pattern description}
- **Test pattern**: `{file:lines}` - {how to test}

### Types & Interfaces
```typescript
// Extend or use these existing types:
{relevant type definitions}
```

### Architecture Notes
- {Key technical decisions}
- {Integration points}
- {Dependencies}

---

## Implementation Summary

### Story Overview
| ID | Title | Priority | Dependencies |
|----|-------|----------|--------------|
| US-001 | {title} | 1 | - |
| US-002 | {title} | 2 | US-001 |
{...}

### Dependency Graph
```
US-001 (schema)
    ↓
US-002 (types)
    ↓
US-003 (backend) → US-004 (UI components)
                        ↓
                   US-005 (integration)
```

---

## Validation Requirements

Every story must pass:
- [ ] Typecheck: `bun run type-check`
- [ ] Lint: `bun run lint`
- [ ] Tests: `bun test`

---

*Generated: {ISO timestamp}*
```

### File 2: prd.json

**Output path**: `.archon/ralph/{feature-slug}/prd.json`

```json
{
  "project": "{ProjectName}",
  "branchName": "ralph/{feature-kebab}",
  "prdFile": "prd.md",
  "description": "{One line summary}",
  "userStories": [
    {
      "id": "US-001",
      "title": "{Short title}",
      "description": "As a {user}, I want {capability} so that {benefit}",
      "acceptanceCriteria": [
        "{Specific verifiable criterion}",
        "Typecheck passes"
      ],
      "technicalNotes": "{Implementation hints from prd.md}",
      "dependsOn": [],
      "priority": 1,
      "passes": false,
      "notes": ""
    }
  ]
}
```

### Story Sizing Rules

**Right-sized (ONE iteration):**
- Add a database column + migration
- Create one utility function + tests
- Add one UI component
- Update one API endpoint

**TOO BIG (split):**
- "Build entire feature" → schema, types, backend, UI
- "Add authentication" → schema, middleware, login UI

### Acceptance Criteria Rules

**GOOD (verifiable):**
- "Add `priority` column with type 'high' | 'medium' | 'low'"
- "Function returns empty array when input is null"
- "Button shows loading state while submitting"

**BAD (vague):**
- "Works correctly"
- "Good UX"
- "Handles edge cases"

---

## Phase 7: OUTPUT

After generating both files, report:

```markdown
## Ralph PRD Created

### Files Generated

| File | Purpose |
|------|---------|
| `.archon/ralph/{feature-slug}/prd.md` | Full context - goals, UX, technical patterns |
| `.archon/ralph/{feature-slug}/prd.json` | Story tracking - passes/fails per story |

### Summary

**Feature**: {name}
**Branch**: `ralph/{feature}`
**Stories**: {count} user stories
**Estimated iterations**: {count}

### User Stories

| # | ID | Title | Dependencies |
|---|-----|-------|--------------|
| 1 | US-001 | {title} | - |
| 2 | US-002 | {title} | US-001 |
{...}

### Context Passed to Each Iteration

Each Ralph iteration receives:
1. **Full PRD** (`.archon/ralph/{feature-slug}/prd.md`) - Goals, persona, UX, technical patterns
2. **Current Story** - From `.archon/ralph/{feature-slug}/prd.json` with acceptance criteria
3. **Previous Learnings** - From `.archon/ralph/{feature-slug}/progress.txt`

### To Start

```bash
# Create feature branch
git checkout -b ralph/{feature-slug}

# Initialize progress
echo "# Ralph Progress Log\nStarted: $(date)\n---" > .archon/ralph/{feature-slug}/progress.txt

# Run Ralph - specify the feature directory
@Archon run ralph .archon/ralph/{feature-slug}
```
```

---

## Question Flow

```
INITIATE → FOUNDATION → UX/DESIGN → TECHNICAL → BREAKDOWN → GENERATE
    ↓           ↓            ↓           ↓           ↓          ↓
 Confirm    Problem,      Journey,   Patterns,   Stories,   prd.md +
  idea      User,         UI reqs,   Types,      DB/API/    prd.json
            Goals         States     Tests       UI split
```

---

## Success Criteria

- **CONTEXT_COMPLETE**: prd.md has goals, persona, UX, technical context
- **STORIES_SIZED**: Each story completable in one iteration
- **DEPENDENCIES_VALID**: Lower priority never depends on higher
- **CRITERIA_VERIFIABLE**: All acceptance criteria are pass/fail
- **READY_TO_RUN**: User can immediately start Ralph loop
