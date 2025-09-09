# Step 05 — UI: TaskEditModal lazy loads details with loading/error states

Goal
- Improve UX: open modal fast using lightweight task; fetch full details only when needed.

Why
- Large fields make modal open sluggish; lazy load fixes perceived performance.

Scope (isolated)
- File: `archon-ui-main/src/features/projects/tasks/components/TaskEditModal.tsx`

Acceptance criteria
- Existing task: triggers `useTaskDetails(taskId, { enabled: isModalOpen })`.
- Loading state: spinner/placeholder visible until details arrive.
- Error state: clear message + Retry; prevent partial writes.

Implementation checklist
1) Use `useTaskDetails` in modal:
   ```tsx
   const { data: taskDetails, isLoading, isError, refetch } =
     useTaskDetails(editingTask?.id, { enabled: isModalOpen && !!editingTask?.id });
   ```
2) Sync local state once details fetched; keep create-new flow unchanged.
3) Show loading UI while fetching; error UI with retry button → `refetch()`.
4) Guard save action if details failed (no partial/corrupted data).

Tests (frontend)
- Location: `archon-ui-main/test/tasks/components.TaskEditModal.test.tsx`
- Cases: loading placeholder; error + retry; prevent save when details missing.

Validation commands (safe)
- `cd archon-ui-main && npm run test:ui -w`

Rollback
- Revert modal changes.

Time estimate
- 30–45 minutes

