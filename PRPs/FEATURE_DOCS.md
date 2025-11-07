# Agent Work Orders - Feature Documentation

## Step Selection (Existing Feature - Phase 0)

### Overview
Users can select which workflow steps to execute when creating a work order.
This feature already exists in the UI and backend - Phase 2 documents it.

### UI Location
- **Component**: `CreateWorkOrderModal.tsx`
- **Field**: "Selected Commands" checkboxes
- **Default**: All steps enabled (create-branch, planning, execute, commit, create-pr)

### Backend Implementation
- **Model**: `CreateAgentWorkOrderRequest.selected_commands`
- **Type**: `list[WorkflowStep]`
- **Validation**: Only valid WorkflowStep enum values allowed
- **Execution**: WorkflowOrchestrator executes only selected steps

### Usage Example
```typescript
// User unchecks "planning" and "execute" steps
// Only creates branch, commits, and creates PR
selected_commands: [
  "create-branch",
  "commit",
  "create-pr"
]
```

### Integration with Phase 2
- Phase 2: Repository has default_commands field
- These defaults populate the checkbox UI
- User can override per work order
- Phase 3: Template execution will respect selected_commands

### Testing
```bash
# Create work order with only planning step
curl -X POST http://localhost:8053/api/agent-work-orders/ \
  -d '{
    "repository_url": "...",
    "user_request": "...",
    "selected_commands": ["planning"]
  }'

# Verify: Only planning step executes
curl -N http://localhost:8053/api/agent-work-orders/{id}/logs/stream | grep "command"
# Should only see: planning.md
```

---

## Phase 2: Priming Context Examples

Priming context is repository-specific information injected into agent prompts.

### Example 1: Monorepo Paths
```json
{
  "paths": {
    "frontend": "apps/web/src",
    "backend": "services/api/src",
    "shared": "packages/shared/src"
  },
  "architecture": "Turborepo monorepo with Next.js frontend and FastAPI backend"
}
```

### Example 2: Microservices
```json
{
  "services": {
    "auth": "services/auth-service",
    "api": "services/api-gateway",
    "worker": "services/background-worker"
  },
  "database": "PostgreSQL with Prisma ORM",
  "message_queue": "RabbitMQ for async jobs"
}
```

### Example 3: Testing Patterns
```json
{
  "test_framework": "pytest",
  "test_location": "tests/ directory (mirrors src/)",
  "conventions": {
    "unit_tests": "tests/unit/test_{module}.py",
    "integration_tests": "tests/integration/test_{feature}.py",
    "fixtures": "tests/conftest.py"
  }
}
```

### How Priming Context is Used

**Phase 2**: Stored in database, editable via UI
**Phase 3**: Injected into agent prompts as `{{priming_context}}` variable
**Example Prompt Template**:
```
You are working on: {{repository.display_name}}

Architecture:
{{priming_context.architecture}}

Key Paths:
{{priming_context.paths}}

User Request: {{user_request}}
```

