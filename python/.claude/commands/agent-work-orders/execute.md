# Execute PRP Plan

Implement a feature plan from the PRPs directory by following its Step by Step Tasks section.

## Variables

Plan file: $ARGUMENTS

## Instructions

- Read the entire plan file carefully
- Execute **every step** in the "Step by Step Tasks" section in order, top to bottom
- Follow the "Testing Strategy" to create proper unit and integration tests
- Complete all "Validation Commands" at the end
- Ensure all linters pass and all tests pass before finishing
- Follow CLAUDE.md guidelines for type safety, logging, and docstrings

## When done

- Move the PRP file to the completed directory in PRPs/features/completed

## Report

- Summarize completed work in a concise bullet point list
- Show files and lines changed: `git diff --stat`
- Confirm all validation commands passed
- Note any deviations from the plan (if any)
