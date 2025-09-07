---
description: Perform comprehensive code review for Archon V2 Beta, this command will save a report to `code-review.md`.
argument-hint: <PR number, branch name, file path, or leave empty for staged changes>
allowed-tools: Bash(*), Read, Grep, LS, Write
thinking: auto
---

# Code Review for Archon V2 Beta

**Review scope**: $ARGUMENTS

I'll perform a comprehensive code review and generate a report saved to the root of this directory as `code-review[n].md`. check if other reviews exist before you create the file and increment n as needed.

## Context

You're reviewing code for Archon V2 Beta, which uses:

- **Frontend**: React + TypeScript + Vite + TailwindCSS
- **Backend**: Python 3.12+ with FastAPI, PydanticAI, Supabase
- **Testing**: Vitest for frontend, pytest for backend
- **Code Quality**: ruff, mypy, ESLint

## What to Review

Determine what needs reviewing:

- If no arguments: Review staged changes (`git diff --staged`)
- If PR number: Review pull request (`gh pr view`)
- If branch name: Compare with main (`git diff main...branch`)
- If file path: Review specific files
- If directory: Review all changes in that area

## Review Focus

### CRITICAL: Beta Error Handling Philosophy

**Following CLAUDE.md principles - We want DETAILED ERRORS, not graceful failures!**

#### Where Errors MUST Bubble Up (Fail Fast & Loud):

- **Service initialization** - If credentials, database, or MCP fails to start, CRASH
- **Configuration errors** - Missing env vars, invalid settings should STOP the system
- **Database connection failures** - Don't hide connection issues, expose them
- **Authentication failures** - Security errors must be visible
- **Data corruption** - Never silently accept bad data
- **Type validation errors** - Pydantic should raise, not coerce

#### Where to Complete but Log Clearly:

- **Background tasks** (crawling, embeddings) - Complete the job, log failures per item
- **Batch operations** - Process what you can, report what failed with details
- **WebSocket events** - Don't crash on single event failure, log and continue
- **Optional features** - If projects/tasks disabled, log and skip
- **External API calls** - Retry with exponential backoff, then fail with clear message

### Python Code Quality

Look for:

- **Type hints** on all functions and proper use of Python 3.12+ features
- **Pydantic v2 patterns** (ConfigDict, model_dump, field_validator)
- **Error handling following beta principles**:

  ```python
  # BAD - Silent failure
  try:
      result = risky_operation()
  except Exception:
      return None

  # GOOD - Detailed error with context
  try:
      result = risky_operation()
  except SpecificError as e:
      logger.error(f"Operation failed at step X: {e}", exc_info=True)
      raise  # Let it bubble up!
  ```

- **No print statements** - should use logging instead
- **Detailed error messages** with context about what was being attempted
- **Stack traces preserved** with `exc_info=True` in logging
- **Async/await** used correctly with proper exception propagation

### TypeScript/React Quality

Look for:

- **TypeScript types** properly defined, avoid `any`
- **React error boundaries** for component failures
- **API error handling** that shows actual error messages:

  ```typescript
  // BAD - Generic error
  catch (error) {
    setError("Something went wrong");
  }

  // GOOD - Specific error with details
  catch (error) {
    console.error("API call failed:", error);
    setError(`Failed to load data: ${error.message}`);
  }
  ```

- **Component structure** following existing patterns
- **Console.error** for debugging, not hidden errors

### Security Considerations

Check for:

- Input validation that FAILS LOUDLY on bad input
- SQL injection vulnerabilities
- No hardcoded secrets or API keys
- Authentication that clearly reports why it failed
- CORS configuration with explicit error messages

### Architecture & Patterns

Ensure:

- Services fail fast on initialization errors
- Routes return detailed error responses with status codes
- Database operations include transaction details in errors
- Socket.IO disconnections are logged with reasons
- Service dependencies checked at startup, not runtime

### Testing

Verify:

- Tests check for specific error messages, not just "throws"
- Error paths are tested with expected error details
- No catch-all exception handlers hiding issues
- Mock failures test error propagation

## Review Process

1. **Understand the changes** - What problem is being solved?
2. **Check functionality** - Does it do what it's supposed to?
3. **Review code quality** - Is it maintainable and follows standards?
4. **Consider performance** - Any N+1 queries or inefficient algorithms?
5. **Verify tests** - Are changes properly tested?
6. **Check documentation** - Are complex parts documented?

## Key Areas to Check

**Backend Python files:**

- `python/src/server/` - Service layer patterns
- `python/src/mcp/` - MCP tool definitions
- `python/src/agents/` - AI agent implementations

**Frontend TypeScript files:**

- `archon-ui-main/src/components/` - React components
- `archon-ui-main/src/services/` - API integration
- `archon-ui-main/src/hooks/` - Custom hooks

**Configuration:**

- `docker-compose.yml` - Service configuration
- `.env` changes - Security implications
- `package.json` / `pyproject.toml` - Dependency changes

## Report Format

Generate a `code-review.md` with:

```markdown
# Code Review

**Date**: [Today's date]
**Scope**: [What was reviewed]
**Overall Assessment**: [Pass/Needs Work/Critical Issues]

## Summary

[Brief overview of changes and general quality]

## Issues Found

### 🔴 Critical (Must Fix)

- [Issue description with file:line reference and suggested fix]

### 🟡 Important (Should Fix)

- [Issue description with file:line reference]

### 🟢 Suggestions (Consider)

- [Minor improvements or style issues]

## What Works Well

- [Positive aspects of the code]

## Security Review

[Any security concerns or confirmations]

## Performance Considerations

[Any performance impacts]

## Test Coverage

- Current coverage: [if available]
- Missing tests for: [list areas]

## Recommendations

[Specific actionable next steps]
```

## Helpful Commands

```bash
# Check what changed
git diff --staged
git diff main...HEAD
gh pr view $PR_NUMBER --json files

# Run quality checks
cd python && ruff check --fix
cd python && mypy src/
cd archon-ui-main && npm run lint

# Run tests
cd python && uv run pytest
cd archon-ui-main && npm test
```

Remember: Focus on impact and maintainability. Good code review helps the team ship better code, not just find problems. Be constructive and specific with feedback.
