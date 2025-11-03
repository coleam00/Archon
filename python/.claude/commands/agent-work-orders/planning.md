# Feature Planning

Create a new plan to implement the `PRP` using the exact specified markdown `PRP Format`. Follow the `Instructions` to create the plan use the `Relevant Files` to focus on the right files.

## Variables

FEATURE $1 $2

## Instructions

- IMPORTANT: You're writing a plan to implement a net new feature based on the `Feature` that will add value to the application.
- IMPORTANT: The `Feature` describes the feature that will be implemented but remember we're not implementing a new feature, we're creating the plan that will be used to implement the feature based on the `PRP Format` below.
- Create the plan in the `PRPs/features/` directory with filename: `{descriptive-name}.md`
  - Replace `{descriptive-name}` with a short, descriptive name based on the feature (e.g., "add-auth-system", "implement-search", "create-dashboard")
- Use the `PRP Format` below to create the plan.
- Deeply research the codebase to understand existing patterns, architecture, and conventions before planning the feature.
- If no patterns are established or are unclear ask the user for clarifications while providing best recommendations and options
- IMPORTANT: Replace every <placeholder> in the `PRP Format` with the requested value. Add as much detail as needed to implement the feature successfully.
- Use your reasoning model: THINK HARD about the feature requirements, design, and implementation approach.
- Follow existing patterns and conventions in the codebase. Don't reinvent the wheel.
- Design for extensibility and maintainability.
- Deeply do web research to understand the latest trends and technologies in the field.
- Figure out latest best practices and library documentation.
- Include links to relevant resources and documentation with anchor tags for easy navigation.
- If you need a new library, use `uv add <package>` and report it in the `Notes` section.
- Read `CLAUDE.md` for project principles, logging rules, testing requirements, and docstring style.
- All code MUST have type annotations (strict mypy enforcement).
- Use Google-style docstrings for all functions, classes, and modules.
- Every new file in `src/` MUST have a corresponding test file in `tests/`.
- Respect requested files in the `Relevant Files` section.

## Relevant Files

Focus on the following files and vertical slice structure:

**Core Files:**

- `CLAUDE.md` - Project instructions, logging rules, testing requirements, docstring style
  app/backend core files
  app/frontend core files

## PRP Format

```md
# Feature: <feature name>

## Feature Description

<describe the feature in detail, including its purpose and value to users>

## User Story

As a <type of user>
I want to <action/goal>
So that <benefit/value>

## Problem Statement

<clearly define the specific problem or opportunity this feature addresses>

## Solution Statement

<describe the proposed solution approach and how it solves the problem>

## Relevant Files

Use these files to implement the feature:

<find and list the files that are relevant to the feature describe why they are relevant in bullet points. If there are new files that need to be created to implement the feature, list them in an h3 'New Files' section. include line numbers for the relevant sections>

## Relevant research docstring

Use these documentation files and links to help with understanding the technology to use:

- [Documentation Link 1](https://example.com/doc1)
  - [Anchor tag]
  - [Short summary]
- [Documentation Link 2](https://example.com/doc2)
  - [Anchor tag]
  - [Short summary]

## Implementation Plan

### Phase 1: Foundation

<describe the foundational work needed before implementing the main feature>

### Phase 2: Core Implementation

<describe the main implementation work for the feature>

### Phase 3: Integration

<describe how the feature will integrate with existing functionality>

## Step by Step Tasks

IMPORTANT: Execute every step in order, top to bottom.

<list step by step tasks as h3 headers plus bullet points. use as many h3 headers as needed to implement the feature. Order matters:

1. Start with foundational shared changes (schemas, types)
2. Implement core functionality with proper logging
3. Create corresponding test files (unit tests mirror src/ structure)
4. Add integration tests if feature interacts with multiple components
5. Verify linters pass: `uv run ruff check src/ && uv run mypy src/`
6. Ensure all tests pass: `uv run pytest tests/`
7. Your last step should be running the `Validation Commands`>

<For tool implementations:

- Define Pydantic schemas in `schemas.py`
- Implement tool with structured logging and type hints
- Register tool with Pydantic AI agent
- Create unit tests in `tests/tools/<name>/test_<module>.py`
- Add integration test in `tests/integration/` if needed>

## Testing Strategy

See `CLAUDE.md` for complete testing requirements. Every file in `src/` must have a corresponding test file in `tests/`.

### Unit Tests

<describe unit tests needed for the feature. Mark with @pytest.mark.unit. Test individual components in isolation.>

### Integration Tests

<if the feature interacts with multiple components, describe integration tests needed. Mark with @pytest.mark.integration. Place in tests/integration/ when testing full application stack.>

### Edge Cases

<list edge cases that need to be tested>

## Acceptance Criteria

<list specific, measurable criteria that must be met for the feature to be considered complete>

## Validation Commands

Execute every command to validate the feature works correctly with zero regressions.

<list commands you'll use to validate with 100% confidence the feature is implemented correctly with zero regressions. Include (example for BE Biome and TS checks are used for FE):

- Linting: `uv run ruff check src/`
- Type checking: `uv run mypy src/`
- Unit tests: `uv run pytest tests/ -m unit -v`
- Integration tests: `uv run pytest tests/ -m integration -v` (if applicable)
- Full test suite: `uv run pytest tests/ -v`
- Manual API testing if needed (curl commands, test requests)>

**Required validation commands:**

- `uv run ruff check src/` - Lint check must pass
- `uv run mypy src/` - Type check must pass
- `uv run pytest tests/ -v` - All tests must pass with zero regressions

**Run server and test core endpoints:**

- Start server: @.claude/start-server
- Test endpoints with curl (at minimum: health check, main functionality)
- Verify structured logs show proper correlation IDs and context
- Stop server after validation

## Notes

<optionally list any additional notes, future considerations, or context that are relevant to the feature that will be helpful to the developer>
```

## Feature

Extract the feature details from the `issue_json` variable (parse the JSON and use the title and body fields).

## Report

- Summarize the work you've just done in a concise bullet point list.
- Include the full path to the plan file you created (e.g., `PRPs/features/add-auth-system.md`)
