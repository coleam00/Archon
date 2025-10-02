# Optimistic Updates Pattern Guide

## Core Architecture

### Shared Utilities Module
**Location**: `src/features/shared/utils/optimistic.ts`

Provides type-safe utilities for managing optimistic state across all features:
- `createOptimisticId()` - Generates stable UUIDs using nanoid
- `createOptimisticEntity<T>()` - Creates entities with `_optimistic` and `_localId` metadata
- `isOptimistic()` - Type guard for checking optimistic state
- `replaceOptimisticEntity()` - Replaces optimistic items by `_localId` (race-condition safe)
- `removeDuplicateEntities()` - Deduplicates after replacement
- `cleanOptimisticMetadata()` - Strips optimistic fields when needed

### TypeScript Interface
```typescript
interface OptimisticEntity {
  _optimistic: boolean;
  _localId: string;
}
```

## Implementation Patterns

### Mutation Hooks Pattern
**Reference**: `src/features/projects/tasks/hooks/useTaskQueries.ts:44-108`

1. **onMutate**: Create optimistic entity with stable ID
   - Use `createOptimisticEntity<T>()` for type-safe creation
   - Store `optimisticId` in context for later replacement

2. **onSuccess**: Replace optimistic with server response
   - Use `replaceOptimisticEntity()` matching by `_localId`
   - Apply `removeDuplicateEntities()` to prevent duplicates

3. **onError**: Rollback to previous state
   - Restore snapshot from context

### UI Component Pattern
**References**:
- `src/features/projects/tasks/components/TaskCard.tsx:39-40,160,186`
- `src/features/projects/components/ProjectCard.tsx:32-33,67,93`
- `src/features/knowledge/components/KnowledgeCard.tsx:49-50,176,244`

1. Check optimistic state: `const optimistic = isOptimistic(entity)`
2. Apply conditional styling: Add opacity and ring effect when optimistic
3. Display indicator: Use `<OptimisticIndicator>` component for visual feedback

### Visual Indicator Component
**Location**: `src/features/ui/primitives/OptimisticIndicator.tsx`

Reusable component showing:
- Spinning loader icon (Loader2 from lucide-react)
- "Saving..." text with pulse animation
- Configurable via props: `showSpinner`, `pulseAnimation`

## Feature Integration

### Tasks
- **Mutations**: `src/features/projects/tasks/hooks/useTaskQueries.ts`
- **UI**: `src/features/projects/tasks/components/TaskCard.tsx`
- Creates tasks with `priority: "medium"` default

### Projects
- **Mutations**: `src/features/projects/hooks/useProjectQueries.ts`
- **UI**: `src/features/projects/components/ProjectCard.tsx`
- Handles `prd: null`, `data_schema: null` for new projects

### Knowledge
- **Mutations**: `src/features/knowledge/hooks/useKnowledgeQueries.ts`
- **UI**: `src/features/knowledge/components/KnowledgeCard.tsx`
- Uses `createOptimisticId()` directly for progress tracking

### Toasts
- **Location**: `src/features/shared/hooks/useToast.ts:43`
- Uses `createOptimisticId()` for unique toast IDs

## Testing

### Unit Tests
**Location**: `src/features/shared/utils/tests/optimistic.test.ts`

Covers all utility functions with 8 test cases:
- ID uniqueness and format validation
- Entity creation with metadata
- Type guard functionality
- Replacement logic
- Deduplication
- Metadata cleanup

### Manual Testing Checklist
1. **Rapid Creation**: Create 5+ items quickly - verify no duplicates
2. **Visual Feedback**: Check optimistic indicators appear immediately
3. **ID Stability**: Confirm nanoid-based IDs after server response
4. **Error Handling**: Stop backend, attempt creation - verify rollback
5. **Race Conditions**: Use browser console script for concurrent creates

## Performance Characteristics

- **Bundle Impact**: ~130 bytes ([nanoid v5, minified+gzipped](https://bundlephobia.com/package/nanoid@5.0.9)) - build/environment dependent
- **Update Speed**: Typically snappy on modern devices; actual latency varies by device and workload
- **ID Generation**: Per [nanoid benchmarks](https://github.com/ai/nanoid#benchmark): secure sync ≈5M ops/s, non-secure ≈2.7M ops/s, async crypto ≈135k ops/s
- **Memory**: Minimal - only `_optimistic` and `_localId` metadata added per optimistic entity

## Migration Notes

### From Timestamp-based IDs
**Before**: `const tempId = \`temp-\${Date.now()}\``
**After**: `const optimisticId = createOptimisticId()`

### Key Differences
- No timestamp collisions during rapid creation
- Stable IDs survive re-renders
- Type-safe with full TypeScript inference
- ~60% code reduction through shared utilities

## Best Practices

1. **Always use shared utilities** - Don't implement custom optimistic logic
2. **Match by _localId** - Never match by the entity's `id` field
3. **Include deduplication** - Always call `removeDuplicateEntities()` after replacement
4. **Show visual feedback** - Users should see pending state clearly
5. **Handle errors gracefully** - Always implement rollback in `onError`

## Dependencies

- **nanoid**: v5.0.9 - UUID generation
- **@tanstack/react-query**: v5.x - Mutation state management
- **React**: v18.x - UI components
- **TypeScript**: v5.x - Type safety

---

*Last updated: Phase 3 implementation (PR #695)*