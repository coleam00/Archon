---
Intended for Jira/GitHub tasks or other task management systems to break down and plan the implementation.
---

# Task Template v2 - Information Dense with Validation Loops

> Concise, executable tasks with embedded context and validation commands

## Format

```
[ACTION] path/to/file:
  - [OPERATION]: [DETAILS]
  - VALIDATE: [COMMAND]
  - IF_FAIL: [DEBUG_HINT]
```

## Actions keywords to use when creating tasks for concise and meaningful descriptions

- **READ**: Understand existing patterns
- **CREATE**: New file with specific content
- **UPDATE**: Modify existing file
- **DELETE**: Remove file/code
- **FIND**: Search for patterns
- **TEST**: Verify behavior
- **FIX**: Debug and repair

## Critical Context Section

```yaml
# Include these BEFORE tasks when context is crucial
context:
  docs:
    - url: [API documentation]
      focus: [specific method/section]

  patterns:
    - file: existing/example.py
      copy: [pattern name]

  gotchas:
    - issue: "Library X requires Y"
      fix: "Always do Z first"
```

## Task Examples with Validation

### Setup Tasks

```
READ src/config/settings.py:
  - UNDERSTAND: Current configuration structure
  - FIND: Model configuration pattern
  - NOTE: Config uses pydantic BaseSettings

READ tests/test_models.py:
  - UNDERSTAND: Test pattern for models
  - FIND: Fixture setup approach
  - NOTE: Uses pytest-asyncio for async tests
```

### Implementation Tasks

````
UPDATE path/to/file:
  - FIND: MODEL_REGISTRY = {
  - ADD: "new-model": NewModelClass,
  - VALIDATE: python -c "from path/to/file import MODEL_REGISTRY; assert 'new-model' in MODEL_REGISTRY"
  - IF_FAIL: Check import statement for NewModelClass

CREATE path/to/file:
  - COPY_PATTERN: path/to/other/file
  - IMPLEMENT:
   - [Detailed description of what needs to be implemented based on codebase intelligence]
  - VALIDATE: uv run pytest path/to/file -v

UPDATE path/to/file:
  - FIND: app.include_router(
  - ADD_AFTER:
    ```python
    from .endpoints import new_model_router
    app.include_router(new_model_router, prefix="/api/v1")
    ```
  - VALIDATE: uv run pytest path/to/file -v
````

## Validation Checkpoints

```
CHECKPOINT syntax:
  - RUN: ruff check && mypy .
  - FIX: Any reported issues
  - CONTINUE: Only when clean

CHECKPOINT tests:
  - RUN: uv run pytest path/to/file -v
  - REQUIRE: All passing
  - DEBUG: uv run pytest -vvs path/to/file/failing_test.py
  - CONTINUE: Only when all green

CHECKPOINT integration:
  - START: docker-compose up -d
  - RUN: ./scripts/integration_test.sh
  - EXPECT: "All tests passed"
  - CLEANUP: docker-compose down
```

## Debug Patterns

```
DEBUG import_error:
  - CHECK: File exists at path
  - CHECK: __init__.py in all parent dirs
  - TRY: python -c "import path/to/file"
  - FIX: Add to PYTHONPATH or fix import

DEBUG test_failure:
  - RUN: uv run pytest -vvs path/to/test.py::test_name
  - ADD: print(f"Debug: {variable}")
  - IDENTIFY: Assertion vs implementation issue
  - FIX: Update test or fix code

DEBUG api_error:
  - CHECK: Server running (ps aux | grep uvicorn)
  - TEST: curl http://localhost:8000/health
  - READ: Server logs for stack trace
  - FIX: Based on specific error
```

## Common Task examples

### Add New Feature

```
1. READ existing similar feature
2. CREATE new feature file (COPY pattern)
3. UPDATE registry/router to include
4. CREATE tests for feature
5. TEST all tests pass
6. FIX any linting/type issues
7. TEST integration works
```

### Fix Bug

```
1. CREATE failing test that reproduces bug
2. TEST confirm test fails
3. READ relevant code to understand
4. UPDATE code with fix
5. TEST confirm test now passes
6. TEST no other tests broken
7. UPDATE changelog
```

### Refactor Code

```
1. TEST current tests pass (baseline)
2. CREATE new structure (don't delete old yet)
3. UPDATE one usage to new structure
4. TEST still passes
5. UPDATE remaining usages incrementally
6. DELETE old structure
7. TEST full suite passes
```

## Tips for Effective Tasks

- Use VALIDATE after every change
- Include IF_FAIL hints for common issues
- Reference specific line numbers or patterns
- Keep validation commands simple and fast
- Chain related tasks with clear dependencies
- Always include rollback/undo steps for risky changes
