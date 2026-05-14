---
description: Create a GDIT spec (requirements.md, design.md, tasks.md) for a feature using spec-first development
argument-hint: <feature name or description>
---

# GDIT Spec: Create

**Feature**: $ARGUMENTS
**Workflow ID**: $WORKFLOW_ID

---

## Your Mission

Create a complete, validated GDIT specification for "$ARGUMENTS" — requirements, design, and tasks — following the GDIT SDAF spec-first development protocol. No code is written. The spec IS the deliverable.

**Core Principle**: Requirements → Design → Tasks → Validate. Every task must trace to a requirement. Every design section must reference tasks and requirements bidirectionally.

---

## Phase 0: PROJECT CONFIG

```bash
cat .kiro/config/project.yaml 2>/dev/null || echo "MISSING"
```

If missing: stop and tell the user to run `gdit-sdaf-setup` first.
If present: read `spec-source` setting. This command supports `spec-source: gdit-sdaf` only.

---

## Phase 1: CODEBASE ANALYSIS

Before writing specs, understand what already exists:

```bash
ls -la
cat package.json 2>/dev/null | head -20
cat pyproject.toml 2>/dev/null | head -20
git log --oneline -10
```

Use Agent(Explore) to find:

- Existing code related to this feature
- Current patterns to preserve or extend
- Relevant test files
- Related specs in `.kiro/specs/` (check for existing work)

Feature slug: derive from "$ARGUMENTS" (lowercase, hyphens, no spaces). Spec directory: `.kiro/specs/<feature-slug>/`

```bash
ls .kiro/specs/<feature-slug>/ 2>/dev/null || echo "NEW"
```

If already exists: read existing specs and ask user: "Spec already exists. Extend (add FIX: prefix tasks) or start fresh?"

---

## Phase 2: CREATE REQUIREMENTS.MD

Create `.kiro/specs/<feature-slug>/requirements.md`:

```markdown
# Requirements: <Feature Name>

## REQ-1: <Requirement Title>

<2-3 sentence description of what must be true.>

**Acceptance Criteria:**

- [ ] <specific, testable criterion 1>
- [ ] <specific, testable criterion 2>
- [ ] <specific, testable criterion 3>

## REQ-2: <Requirement Title>

...
```

Rules:

- Minimum 2 requirements, maximum 8 for most features
- Each criterion must be testable ("returns X when Y" not "works correctly")
- Derive from "$ARGUMENTS" and codebase analysis in Phase 1

---

## Phase 3: CREATE DESIGN.MD

Create `.kiro/specs/<feature-slug>/design.md`:

```markdown
# Design: <Feature Name>

## Overview

<Architecture summary — how this fits into the existing codebase.>

## <Section Name> (REQ-1)

**Implementation approach**: <how to implement this>

**Correctness Properties:**

- <invariant the implementation must maintain>

**Implemented by**: Task 1, Task 2

...
```

Rules:

- Each section header must reference a valid REQ-N from requirements.md
- Each `**Implemented by**: Task N` must reference tasks that will exist in tasks.md
- Reference actual file paths found in Phase 1

---

## Phase 4: CREATE TASKS.MD

Create `.kiro/specs/<feature-slug>/tasks.md`:

```markdown
# Tasks: <Feature Name>

## Task 1: <Task Title>

**Addresses**: REQ-1, REQ-2
**Design**: design.md#section-anchor
**Estimated effort**: Traditional: Xh | AI-assisted: Xh

Subtasks:

- [ ] <specific subtask>
- [ ] <specific subtask>
- [ ] Write tests for acceptance criteria (if testing enabled)
- [ ] Type-check passes

## Task 2: <Task Title>

...
```

Rules:

- Every task must have `**Addresses**: REQ-N`
- Tasks should be implementable in 1-4 hours each
- Include effort estimates for value tracking

---

## Phase 5: VALIDATE SPEC

```bash
python3 ~/.kiro/scripts/validate-spec.py .kiro/specs/<feature-slug>/
```

If FAIL results exist: fix the specific issues and re-run until 0 FAILs.

---

## Phase 6: REPORT

Present:

- Spec location: `.kiro/specs/<feature-slug>/`
- Requirements count and summary
- Tasks count and total estimated effort
- Validation output (must be PASS)
- Ask: "Spec is ready. Say `implement` to begin implementation, or request changes."

**PHASE_6_CHECKPOINT:**

- [ ] requirements.md created with ≥2 REQ sections each having Acceptance Criteria
- [ ] design.md created with sections referencing REQ-N and tasks
- [ ] tasks.md created with ≥1 task per requirement
- [ ] validate-spec.py shows 0 FAIL results
