# Optimistic Updates Pattern (Future State)

**⚠️ STATUS: This is NOT currently implemented. This document describes the desired future state for handling optimistic updates in a simple, consistent way.**

## Mental Model

Think of optimistic updates as "assuming success" - update the UI immediately for instant feedback, then verify with the server. If something goes wrong, revert to the last known good state.

## The Pattern

```typescript
// 1. Save current state (for rollback)
const previousState = currentState; // Note: Use deep clone for objects/arrays in production

// 2. Update UI immediately
setState(newState);

// 3. Call API
try {
  await api.updateResource(newState);
  // Success - UI already updated, nothing to do
} catch (error) {
  // 4. Rollback on failure
  setState(previousState);
  showToast("Failed to update. Reverted changes.", "error");
}
```

## Implementation Approach

### Simple Hook Pattern
```typescript
function useOptimistic<T>(
  initialValue: T,
  updateFn: (value: T) => Promise<T>
) {
  const [value, setValue] = useState(initialValue);
  const [isUpdating, setIsUpdating] = useState(false);
  const previousValueRef = useRef<T>(initialValue);

  const optimisticUpdate = async (newValue: T) => {
    // Save for rollback
    previousValueRef.current = value;
    
    // Update immediately
    setValue(newValue);
    setIsUpdating(true);

    try {
      const result = await updateFn(newValue);
      setValue(result); // Use server response as source of truth
    } catch (error) {
      // Rollback
      setValue(previousValueRef.current);
      throw error;
    } finally {
      setIsUpdating(false);
    }
  };

  return { value, optimisticUpdate, isUpdating };
}
```

### Usage Example
```typescript
// In a component
const { value: task, optimisticUpdate, isUpdating } = useOptimistic(
  initialTask,
  (task) => projectService.updateTask(task.id, task)
);

// Handle user action
const handleStatusChange = (newStatus: string) => {
  optimisticUpdate({ ...task, status: newStatus })
    .catch(error => showToast("Failed to update task", "error"));
};
```

## Key Principles

1. **Keep it simple** - Just save, update, and rollback
2. **Server is truth** - Always use server response as final state
3. **User feedback** - Show loading states and error messages
4. **Selective usage** - Only for actions where instant feedback matters:
   - Drag and drop
   - Status changes
   - Toggle switches
   - Quick edits

## What NOT to Do

- Don't track complex state histories
- Don't try to merge conflicts
- Don't use for create/delete operations (too complex to rollback cleanly)
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

These complexities are why we recommend starting simple and only adding optimistic updates where the UX benefit is clear.