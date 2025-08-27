---
name: "Story PRP Template - Task Implementation Focus"
description: "Template for converting user stories into executable implementation tasks"
---

## Original Story

Paste in the original story shared by the user below:

```
[User story/task description from Jira/Linear/etc]
```

## Story Metadata

**Story Type**: [Feature/Bug/Enhancement/Refactor]
**Estimated Complexity**: [Low/Medium/High]
**Primary Systems Affected**: [List of main components/services]

---

## CONTEXT REFERENCES

[Auto-discovered documentation and patterns]

- {file_path} - {Why this pattern/file is relevant}
- {doc_path} - {Specific sections needed for implementation}
- {external_url} - {Library documentation or examples}

---

## IMPLEMENTATION TASKS

[Task blocks in dependency order - each block is atomic and testable]

### Concept For tasks

- We are using Information dense keywords to be specific and concise about implementation steps and details.
- The tasks have to be detailed and specific to ensure clarity and accuracy.
- The developer that will execute the tasks should be able to complete the task using only the context of this file, with references to relevant codebase paths and integration points.

### {ACTION} {target_file}:

- {VERB/KEYWORD}: {Specific implementation detail}
- {PATTERN}: {Existing pattern to follow from codebase}
- {IMPORTS}: {Required imports or dependencies}
- {GOTCHA}: {Known issues or constraints to avoid}
- **VALIDATE**: `{executable validation command}`

### Example Format:

### CREATE services/user_service.py:

- IMPLEMENT: UserService class with async CRUD operations
- PATTERN: Follow services/product_service.py structure
- IMPORTS: from models.user import User; from db import get_session
- GOTCHA: Always use async session context manager
- **VALIDATE**: ` uv run python -c "from services.user_service import UserService; print('✓ Import successful')"`

### UPDATE api/routes.py:

- ADD: user_router to main router
- FIND: `app.include_router(product_router)`
- INSERT: `app.include_router(user_router, prefix="/users", tags=["users"])`
- **VALIDATE**: `grep -q "user_router" api/routes.py && echo "✓ Router added"`

### ADD tests/

- CREATE: tests/user_service_test.py
- IMPLEMENT: Test cases for UserService class
- PATTERN: Follow tests/product_service_test.py structure
- IMPORTS: from services.user_service import UserService; from models.user import User; from db import get_session
- GOTCHA: Use async session context manager in tests
- **VALIDATE**: `uv run python -m pytest tests/user_service_test.py && echo "✓ Tests passed"`

---

## Validation Loop

### Level 1: Syntax & Style (Immediate Feedback)

```bash
# Run after each file creation - fix before proceeding
ruff check src/{new_files} --fix     # Auto-format and fix linting issues
mypy src/{new_files}                 # Type checking with specific files
ruff format src/{new_files}          # Ensure consistent formatting

# Project-wide validation
ruff check src/ --fix
mypy src/
ruff format src/

# Expected: Zero errors. If errors exist, READ output and fix before proceeding.
```

### Level 2: Unit Tests (Component Validation)

```bash
# Test each component as it's created
uv run pytest src/services/tests/test_{domain}_service.py -v
uv run pytest src/tools/tests/test_{action}_{resource}.py -v

# Full test suite for affected areas
uv run pytest src/services/tests/ -v
uv run pytest src/tools/tests/ -v

# Coverage validation (if coverage tools available)
uv run pytest src/ --cov=src --cov-report=term-missing

# Expected: All tests pass. If failing, debug root cause and fix implementation.
```

### Level 3: Integration Testing (System Validation)

```bash
# Service startup validation
uv run python main.py &
sleep 3  # Allow startup time

# Health check validation
curl -f http://localhost:8000/health || echo "Service health check failed"

# Feature-specific endpoint testing
curl -X POST http://localhost:8000/{your_endpoint} \
  -H "Content-Type: application/json" \
  -d '{"test": "data"}' \
  | jq .  # Pretty print JSON response

# MCP server validation (if MCP-based)
# Test MCP tool functionality
echo '{"method": "tools/call", "params": {"name": "{tool_name}", "arguments": {}}}' | \
  uv run python -m src.main

# Database validation (if database integration)
# Verify database schema, connections, migrations
psql $DATABASE_URL -c "SELECT 1;" || echo "Database connection failed"

# Expected: All integrations working, proper responses, no connection errors
```

### Level 4: Creative & Domain-Specific Validation

You can use CLI that are installed on the system or MCP servers to extend the validation and self closing loop.

Identify if you are connected to any MCP servers that can be used for validation and if you have any cli tools installed on the system that can help with validation.

For example:

```bash
# MCP Server Validation Examples:

# Playwright MCP (for web interfaces)
playwright-mcp --url http://localhost:8000 --test-user-journey

# Docker MCP (for containerized services)
docker-mcp --build --test --cleanup

# Database MCP (for data operations)
database-mcp --validate-schema --test-queries --check-performance
```

---

## COMPLETION CHECKLIST

- [ ] All tasks completed
- [ ] Each task validation passed
- [ ] Full test suite passes
- [ ] No linting errors
- [ ] All available validation gates passed
- [ ] Story acceptance criteria met

---

## Notes

[Any additional context, decisions made, or follow-up items]

```

```
