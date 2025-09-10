# Step 04 — Frontend Hooks: useTaskDetails + lightweight useProjectTasks

Goal
- Provide hooks aligned with lazy loading and polling strategy.

Why
- Encapsulates query behavior (keys, ETag, polling) without prop drilling.

Scope (isolated)
- File: `archon-ui-main/src/features/projects/tasks/hooks/useTaskQueries.ts`

Acceptance criteria
- `useTaskDetails(taskId, { enabled })` supports options object.
- `useProjectTasks(projectId)` defaults to lightweight list and smart polling.

Implementation checklist
1) Add query keys factory:
   ```ts
   export const taskKeys = {
     all: (projectId: string) => ["projects", projectId, "tasks"] as const,
     details: (taskId: string) => ["tasks", taskId, "details"] as const,
   };
   ```
2) Implement `useTaskDetails`:
   ```ts
   export function useTaskDetails(taskId?: string, opts?: { enabled?: boolean }) {
     return useQuery<Task>({
       queryKey: taskId ? taskKeys.details(taskId) : ["task-details-undefined"],
       queryFn: () => taskService.getTaskDetails(taskId!),
       enabled: !!taskId && (opts?.enabled ?? true),
       staleTime: 30_000,
     });
   }
   ```
3) Update `useProjectTasks` to use lightweight list and smart polling.

Tests (frontend)
- Location: `archon-ui-main/test/tasks/hooks.useTaskQueries.test.tsx`
- Cases: enabled flag respected; correct keys; list uses lightweight endpoint.

Validation commands (safe)
- `cd archon-ui-main && npm run test -w`

Rollback
- Revert hook changes.

Time estimate
- 25–35 minutes

