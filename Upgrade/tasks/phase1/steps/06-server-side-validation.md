# Step 06 — Backend: Server-side validation (50k description limit)

Goal
- Enforce description length limit server-side to fail fast on invalid data.

Why
- Prevents oversized payloads and ensures data integrity per Beta Guidelines.

Scope (isolated)
- New schema: `python/src/server/schemas/tasks.py`
- Integrate into create/update paths in services/routes

Acceptance criteria
- Requests with `description` > 50,000 characters are rejected with clear 4xx error.
- Valid requests continue to work unchanged.

Implementation checklist
1) Add Pydantic schemas:
   ```python
   from pydantic import BaseModel, constr

   class TaskUpdate(BaseModel):
       description: constr(max_length=50000) | None = None
       # add other fields as needed
   ```
2) Use schema in update/create handlers; return explicit errors on validation failure.
3) Add detailed logging for validation errors.

Tests (backend)
- Location: `python/tests/test_task_validation.py`
- Cases: valid boundary (50,000), reject 50,001, null allowed.

Validation commands (safe)
- `uv run pytest -k task_validation -v`

Rollback
- Remove schema usage (not recommended).

Time estimate
- 30–45 minutes

