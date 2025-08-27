---
description: "Execute a Story PRP with focused task implementation"
---

# Execute Story PRP

## PRP File: $ARGUMENTS

## Mission

Execute a story/task PRP through **sequential task completion** with immediate validation.

**Execution Philosophy**: Complete one task, validate it, then move to the next. No task left behind.

## Execution Process

### 1. Load Story PRP

- Read the specified story PRP file
- Understand the original story intent
- Review all context references
- Note validation commands for each task

### 2. Pre-Implementation Check

- Ultrathink about the story intent and task requirements
- Verify all referenced files exist
- Check that patterns mentioned are accessible
- Ensure development environment is ready
- Run any pre-requisite setup commands

### 3. Task-by-Task Implementation

For each task in the PRP:

**a) Understand Task**

- Read task requirements completely
- Review referenced patterns
- Check gotchas and constraints

**b) Implement Task**

- Follow the specified pattern
- Use the indicated naming conventions
- Apply the documented approach
- Handle edge cases mentioned

**c) Validate Immediately**

- Run the task's validation command
- If validation fails, fix and re-validate
- Don't proceed until current task passes

**d) Mark Complete**

- Update todo list to track progress
- Document any deviations if necessary

### 4. Full Validation

After all tasks complete:

- Run the validation gates from PRP
- Execute comprehensive test suite
- Verify all acceptance criteria met

### 5. Completion

- Work through completion checklist
- Ensure story requirements satisfied
- Move completed PRP to PRPs/completed/ create the folder if it does not exist

## Execution Rules

**Validation Gates**: Each task must pass validation, iterate until passed
**Pattern Adherence**: Follow existing patterns, don't create new ones
**No Shortcuts**: Complete all validation steps

## Failure Handling

When a task fails validation:

1. Read the error message carefully
2. Check the pattern reference again
3. Validate it by investigating the codebase
4. Fix and re-validate
5. If stuck, check similar implementations

## Success Criteria

- Every validation command passes
- Full test suite green
- Story acceptance criteria met
- Code follows project conventions
