---
description: Generate draft GSD .planning project artifacts for approval
argument-hint: <project idea or path to source document>
---

# Generate GSD Project Artifacts

**Input**: $ARGUMENTS
**Artifacts directory**: $ARTIFACTS_DIR

## Mission

Generate draft GSD-style project planning artifacts under `$ARTIFACTS_DIR/gsd-project-draft/.planning/`. Do not write directly to repository `.planning/`; the workflow installs drafts after human approval.

## Required process

1. Read `$ARTIFACTS_DIR/project-intake.md`.
2. Read `$ARTIFACTS_DIR/project-research.md`.
3. Create `$ARTIFACTS_DIR/gsd-project-draft/.planning/`.
4. Write the required files listed below.

## Required files

### `PROJECT.md`

Include:

- Project overview
- Target users
- Product goals
- Technical context
- Constraints
- Success definition
- Open questions

### `REQUIREMENTS.md`

Include:

- Requirement IDs
- Requirement descriptions
- Priority
- Acceptance criteria
- Suggested phase mapping
- Traceability table

### `ROADMAP.md`

Include:

- Ordered phases
- Phase goals
- Success criteria
- Requirement IDs covered by each phase
- Dependencies
- Initial status

### `STATE.md`

Include:

- Current phase pointer
- Current plan pointer
- Project status
- Decisions log
- Blockers
- Progress summary
- Last session notes

### `config.json`

Include sensible defaults for:

- `mode`
- `granularity`
- `model_profile`
- `workflow.research`
- `workflow.plan_check`
- `workflow.verifier`
- `workflow.auto_advance`

Use valid JSON.

## Final response

Return a concise summary and list every file created under `$ARTIFACTS_DIR/gsd-project-draft/.planning/`.
