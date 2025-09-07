# Code Review

Please perform a comprehensive code review of the current changes or specified files.

## Review Scope
$ARGUMENTS

## Review Process

1. **Understand Changes**
   - If reviewing staged changes: `git diff --staged`
   - If reviewing specific files: Read the specified files
   - If reviewing a PR: `gh pr view $ARGUMENTS --json files,additions,deletions`
   - If reviewing a local directory: `git diff $ARGUMENTS`
   - If reviewing the entire codebase: `git diff origin/main`

## Review Focus Areas

1. **Code Quality**
   - Type hints on all functions and classes
   - Pydantic v2 models for data validation
   - No print() statements (use logging)
   - Proper error handling
   - Following PEP 8
   - Docstrings following google style python docstrings

2. **Pydantic v2 Patterns**
   - Using ConfigDict not class Config
   - field_validator not @validator
   - model_dump() not dict()
   - Proper use of Annotated types

3. **Security**
   - Input validation on all endpoints
   - No SQL injection vulnerabilities
   - Passwords properly hashed
   - No hardcoded secrets

4. **Structure**
   - Unit tests are co-located with the code they test in tests/ folders
   - Each feature is self-contained with its own models, service, and tools
   - Shared components are only things used by multiple features
   - Future improvements (like multiple AI providers) would go in src/shared/ai_providers/ when implemented
   - Integration tests remain at the root level in tests/integration/

5. **Linting**
   - ruff check --fix
   - mypy

6. **Testing**
   - New code has tests
   - Edge cases covered
   - Mocking external dependencies

7. **Performance**
   - No N+1 queries
   - Efficient algorithms
   - Proper async usage

8. **Documentation**
   - Clear README with setup instructions
   - CLAUDE.md is up to date with any new important utils, dependencies etc for future cluade code instances

## Review Output

Create a concise review report with:

```markdown
# Code Review #[number]

## Summary
[2-3 sentence overview]

## Issues Found

### 🔴 Critical (Must Fix)
- [Issue with file:line and suggested fix]

### 🟡 Important (Should Fix)
- [Issue with file:line and suggested fix]

### 🟢 Minor (Consider)
- [Improvement suggestions]

## Good Practices
- [What was done well]

## Test Coverage
Current: X% | Required: 80%
Missing tests: [list]
Save report to PRPs/code_reviews/review[#].md (check existing files first)

