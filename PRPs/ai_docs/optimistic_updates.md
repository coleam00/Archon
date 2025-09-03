# Optimistic Updates Pattern (Future State)

**⚠️ STATUS:** This is not currently implemented. There is a proof‑of‑concept (POC) on the frontend Project page. This document describes the desired future state for handling optimistic updates in a simple, consistent way.

## Mental Model

Think of optimistic updates as "assuming success" - update the UI immediately for instant feedback, then verify with the server. If something goes wrong, revert to the last known good state.

## The Pattern

```typescript
// 1. Save current state (for rollback) — take an immutable snapshot
const previousState = structuredClone(currentState);

// 2. Update UI immediately
setState(newState);

// 3. Call API
try {
  const serverState = await api.updateResource(newState);
  // Success — use server as the source of truth
  setState(serverState);
} catch (error) {
  // 4. Rollback on failure
  setState(previousState);
  showToast("Failed to update. Reverted changes.", "error");
}
```

## Implementation Approach

### Simple Hook Pattern

```typescript
function useOptimistic<T>(initialValue: T, updateFn: (value: T) => Promise<T>) {
  const [value, setValue] = useState(initialValue);
  const [isUpdating, setIsUpdating] = useState(false);
  const previousValueRef = useRef<T>(initialValue);
  const opSeqRef = useRef(0);      // monotonically increasing op id
  const mountedRef = useRef(true); // avoid setState after unmount
  useEffect(() => () => { mountedRef.current = false; }, []);

  const optimisticUpdate = async (newValue: T) => {
    const opId = ++opSeqRef.current;
    // Save for rollback
    previousValueRef.current = value;

    // Update immediately
    if (mountedRef.current) setValue(newValue);
    if (mountedRef.current) setIsUpdating(true);

    try {
      const result = await updateFn(newValue);
      // Apply only if latest op and still mounted
      if (mountedRef.current && opId === opSeqRef.current) {
        setValue(result); // Server is source of truth
      }
    } catch (error) {
      // Rollback
      if (mountedRef.current && opId === opSeqRef.current) {
        setValue(previousValueRef.current);
      }
      throw error;
    } finally {
      if (mountedRef.current && opId === opSeqRef.current) {
        setIsUpdating(false);
      }
    }
  };

  return { value, optimisticUpdate, isUpdating };
}
```

### Usage Example

```typescript
// In a component
const {
  value: task,
  optimisticUpdate,
  isUpdating,
} = useOptimistic(initialTask, (task) =>
  projectService.updateTask(task.id, task),
);

// Handle user action
const handleStatusChange = (newStatus: string) => {
  optimisticUpdate({ ...task, status: newStatus }).catch((error) =>
    showToast("Failed to update task", "error"),
  );
};
```

## Key Principles

1. **Keep it simple** — save, update, roll back.
2. **Server is the source of truth** — always use the server response as the final state.
3. **User feedback** — show loading states and clear error messages.
4. **Selective usage** — only where instant feedback matters:
   - Drag‑and‑drop
   - Status changes
   - Toggle switches
   - Quick edits

## What NOT to Do

- Don't track complex state histories
- Don't try to merge conflicts
- Use with caution for create/delete operations. If used, generate temporary client IDs, reconcile with server‑assigned IDs, ensure idempotency, and define clear rollback/error states. Prefer non‑optimistic flows when side effects are complex.
- Don't over-engineer with queues or reconciliation

## When to Implement

Implement optimistic updates when:

- Users complain about UI feeling "slow"
- Drag-and-drop or reordering feels laggy
- Quick actions (like checkbox toggles) feel unresponsive
- Network latency is noticeable (> 200ms)

## Success Metrics

When implemented correctly:

- UI feels instant (< 100ms response)
- Rollbacks are rare (< 1% of updates)
- Error messages are clear
- Users understand what happened when things fail

## Production Considerations

The examples above are simplified for clarity. Production implementations should consider:

1. **Deep cloning**: Use `structuredClone()` or a deep clone utility for complex state

   ```typescript
   const previousState = structuredClone(currentState); // Proper deep clone
   ```

2. **Race conditions**: Handle out-of-order responses with operation IDs
3. **Unmount safety**: Avoid setState after component unmount
4. **Debouncing**: For rapid updates (e.g., sliders), debounce API calls
5. **Conflict resolution**: For collaborative editing, consider operational transforms
6. **Polling/ETag interplay**: When polling, ignore stale responses (e.g., compare opId or Last-Modified) and rely on ETag/304 to prevent flicker overriding optimistic state.
7. **Idempotency & retries**: Use idempotency keys on write APIs so client retries (or duplicate submits) don't create duplicate effects.

These complexities are why we recommend starting simple and only adding optimistic updates where the UX benefit is clear.
