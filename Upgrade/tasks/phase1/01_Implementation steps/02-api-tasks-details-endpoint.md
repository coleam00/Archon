# Step 02 — API: Add task details endpoint and enforce scope

Goal
- Provide a dedicated endpoint for full task details; validate task ↔ project scope when applicable.

Why
- Lists should be lightweight; large fields only on demand.
- Prevent cross-project data exposure.

Scope (isolated)
- New router: `python/src/server/api_routes/tasks_api.py`
- Service call: `TaskService.get_task_details(task_id)` (implemented in Step 01/02)

Acceptance criteria
- `GET /api/tasks/{task_id}/details` returns the full task object or 404.
- Clear error logging with stacktrace on failure; no partial returns.
- Optional: if project context provided, enforce task belongs to project.

Implementation checklist
1) Create tasks_api router with details endpoint:
   ```python
   @router.get("/tasks/{task_id}/details")
   async def get_task_details(task_id: str):
       try:
           from fastapi.concurrency import run_in_threadpool
           ok, result = await run_in_threadpool(TaskService().get_task_details, task_id)
           if not ok:
               raise HTTPException(status_code=404, detail=result.get("error", "Task not found"))
           return {"task": result["task"]}
       except HTTPException:
           raise
       except Exception as e:
           logfire.error("Failed to get task details", extra={"task_id": task_id}, exc_info=True)
           raise HTTPException(status_code=500, detail="Internal Server Error")
2) Wire router into `main.py` or router aggregator.
3) Update OpenAPI docs; add examples.

Tests (backend)
- Location: `python/tests/test_task_details_endpoint.py`
- Cases: 200 (found), 404 (missing), error logging.

Validation commands (safe)
- `uv run pytest -k task_details_endpoint -v`

Rollback
- Remove router/route; no data migration involved.

Time estimate
- 30–45 minutes

