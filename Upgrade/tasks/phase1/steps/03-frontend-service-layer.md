# Step 03 — Frontend Service Layer: Lightweight lists + details fetch

Goal
- Service methods that default to lightweight lists and fetch full details on demand.

Why
- Aligns with reduced payload strategy and lazy loading UX.

Scope (isolated)
- File: `archon-ui-main/src/features/projects/tasks/services/taskService.ts`

Acceptance criteria
- `getTasksByProject(projectId, true)` is default and excludes large fields (via query param).
- `getTaskDetails(taskId)` fetches full task via details endpoint.

Implementation checklist
1) Implement `getTaskDetails`:
   ```ts
   async getTaskDetails(taskId: string): Promise<Task> {
     return callAPIWithETag<Task>(`/api/tasks/${taskId}/details`);
   }
   ```
2) Update `getTasksByProject` default:
   ```ts
   async getTasksByProject(projectId: string, excludeLargeFields = true): Promise<Task[]> {
     const params = excludeLargeFields ? "?exclude_large_fields=true" : "";
     return callAPIWithETag<Task[]>(`/api/projects/${projectId}/tasks${params}`);
   }
   ```

Tests (frontend)
- Location: `archon-ui-main/test/tasks/service.taskService.test.ts`
- Cases: builds correct URLs; parses responses; error path.

Validation commands (safe)
- `cd archon-ui-main && npm run test -w`

Rollback
- Revert the two method changes.

Time estimate
- 20–30 minutes

