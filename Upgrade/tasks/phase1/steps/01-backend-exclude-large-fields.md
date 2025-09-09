# Step 01 — Backend: Fix exclude_large_fields in list tasks (and set default)

Goal
- Ensure task list queries exclude large fields (description, sources, code_examples) by default to reduce payload by ~95%.

Why
- Current list responses include large JSON/text fields, causing 8–15 KB per task.
- MCP/tools and UI expect lightweight lists; details are fetched on demand.

Scope (isolated)
- Service: `python/src/server/services/projects/task_service.py`
- API default: `python/src/server/api_routes/projects_api.py` (or consolidated `tasks_api.py` in Step 02)
- Tests only for this behavior

Acceptance criteria
- GET /api/projects/{project_id}/tasks returns list without description/sources/code_examples when no param provided.
- Query param `exclude_large_fields=false` re-enables full payload for debugging only.
- Unit tests verify absence of large fields.

Implementation checklist
1) Update selection when `exclude_large_fields=True`:
   ```python
   # in TaskService.list_tasks (or equivalent list method)
   if exclude_large_fields:
       query = self.supabase_client.table("archon_tasks").select(
           "id, project_id, parent_task_id, title, status, assignee, task_order, "
           "feature, archived, archived_at, archived_by, created_at, updated_at"
       )
   else:
       query = self.supabase_client.table("archon_tasks").select("*")
   ```
2) Set API default to `exclude_large_fields=True`:
   ```python
   # in projects_api.list_project_tasks or tasks_api.list_project_tasks
   async def list_project_tasks(..., exclude_large_fields: bool = True):
       ...
   ```
3) Ensure request param still supported: `?exclude_large_fields=false`.

Tests (backend)
- Location: `python/tests/test_tasks_list_lightweight.py`
- Cases:
  - Default: large fields absent
  - Explicit `exclude_large_fields=true`: large fields absent
  - Explicit `exclude_large_fields=false`: large fields present

Validation commands (safe)
- Backend lint/type: `uv run ruff check` and `uv run mypy src/`
- Unit tests: `uv run pytest -k tasks_list_lightweight -v`

Metrics to capture
- Response size for 50 tasks before/after (log or local measurement)

Rollback
- Revert the selection and default parameter change.

Time estimate
- 45–60 minutes

