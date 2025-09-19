# TanStack Query Patterns Guide

This guide documents the standardized patterns for using TanStack Query v5 in the Archon frontend.

## Core Principles

1. **Feature Ownership**: Each feature owns its query keys in `{feature}/hooks/use{Feature}Queries.ts`
2. **Consistent Patterns**: Always use shared patterns from `shared/queryPatterns.ts`
3. **No Hardcoded Values**: Never hardcode stale times or disabled keys
4. **Mirror Backend API**: Query keys should exactly match backend API structure

## Query Key Factory Pattern

Every feature MUST implement a query key factory following this pattern:

```typescript
// features/{feature}/hooks/use{Feature}Queries.ts
export const featureKeys = {
  all: ["feature"] as const,                                    // Base key for the domain
  lists: () => [...featureKeys.all, "list"] as const,          // For list endpoints
  detail: (id: string) => [...featureKeys.all, "detail", id] as const, // For single item
  // Add more as needed following backend routes
};
```

### Examples from Codebase

```typescript
// Projects - Simple hierarchy
export const projectKeys = {
  all: ["projects"] as const,
  lists: () => [...projectKeys.all, "list"] as const,
  detail: (id: string) => [...projectKeys.all, "detail", id] as const,
  features: (id: string) => [...projectKeys.all, id, "features"] as const,
};

// Tasks - Dual nature (global and project-scoped)
export const taskKeys = {
  all: ["tasks"] as const,
  lists: () => [...taskKeys.all, "list"] as const,              // /api/tasks
  detail: (id: string) => [...taskKeys.all, "detail", id] as const,
  byProject: (projectId: string) => ["projects", projectId, "tasks"] as const, // /api/projects/{id}/tasks
  counts: () => [...taskKeys.all, "counts"] as const,
};
```

## Shared Patterns Usage

### Import Required Patterns

```typescript
import { DISABLED_QUERY_KEY, STALE_TIMES } from "@/features/shared/queryPatterns";
```

### Disabled Queries

Always use `DISABLED_QUERY_KEY` when a query should not execute:

```typescript
// ✅ CORRECT
queryKey: projectId ? projectKeys.detail(projectId) : DISABLED_QUERY_KEY,

// ❌ WRONG - Don't create custom disabled keys
queryKey: projectId ? projectKeys.detail(projectId) : ["projects-undefined"],
```

### Stale Times

Always use `STALE_TIMES` constants for cache configuration:

```typescript
// ✅ CORRECT
staleTime: STALE_TIMES.normal,        // 30 seconds
staleTime: STALE_TIMES.frequent,      // 5 seconds
staleTime: STALE_TIMES.instant,       // 0 - always fresh

// ❌ WRONG - Don't hardcode times
staleTime: 30000,
staleTime: 0,
```

#### STALE_TIMES Reference

- `instant: 0` - Always fresh (real-time data like active progress)
- `realtime: 3_000` - 3 seconds (near real-time updates)
- `frequent: 5_000` - 5 seconds (frequently changing data)
- `normal: 30_000` - 30 seconds (standard cache time)
- `rare: 300_000` - 5 minutes (rarely changing config)
- `static: Infinity` - Never stale (settings, auth)

## Complete Hook Pattern

```typescript
export function useFeatureDetail(id: string | undefined) {
  return useQuery({
    queryKey: id ? featureKeys.detail(id) : DISABLED_QUERY_KEY,
    queryFn: () => id
      ? featureService.getFeatureById(id)
      : Promise.reject("No ID provided"),
    enabled: !!id,
    staleTime: STALE_TIMES.normal,
  });
}
```

## Mutations with Optimistic Updates

```typescript
import { createOptimisticEntity, replaceOptimisticEntity } from "@/features/shared/optimistic";

export function useCreateFeature() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateFeatureRequest) => featureService.create(data),

    onMutate: async (newData) => {
      // Cancel in-flight queries
      await queryClient.cancelQueries({ queryKey: featureKeys.lists() });

      // Snapshot for rollback
      const previous = queryClient.getQueryData(featureKeys.lists());

      // Optimistic update with nanoid for stable IDs
      const optimisticEntity = createOptimisticEntity(newData);
      queryClient.setQueryData(featureKeys.lists(), (old: Feature[] = []) =>
        [...old, optimisticEntity]
      );

      return { previous, localId: optimisticEntity._localId };
    },

    onError: (err, variables, context) => {
      // Rollback on error
      if (context?.previous) {
        queryClient.setQueryData(featureKeys.lists(), context.previous);
      }
    },

    onSuccess: (data, variables, context) => {
      // Replace optimistic with real data
      queryClient.setQueryData(featureKeys.lists(), (old: Feature[] = []) =>
        replaceOptimisticEntity(old, context?.localId, data)
      );
    },
  });
}
```

## Testing Query Hooks

Always mock both services and shared patterns:

```typescript
// Mock services
vi.mock("../../services", () => ({
  featureService: {
    getList: vi.fn(),
    getById: vi.fn(),
  },
}));

// Mock shared patterns with ALL values
vi.mock("../../../shared/queryPatterns", () => ({
  DISABLED_QUERY_KEY: ["disabled"] as const,
  STALE_TIMES: {
    instant: 0,
    realtime: 3_000,
    frequent: 5_000,
    normal: 30_000,
    rare: 300_000,
    static: Infinity,
  },
}));
```

## Vertical Slice Architecture

Each feature is self-contained:

```text
src/features/projects/
├── components/         # UI components
├── hooks/
│   └── useProjectQueries.ts  # Query hooks & keys
├── services/
│   └── projectService.ts     # API calls
└── types/
    └── index.ts              # TypeScript types
```

Sub-features (like tasks under projects) follow the same structure:

```text
src/features/projects/tasks/
├── components/
├── hooks/
│   └── useTaskQueries.ts    # Own query keys!
├── services/
└── types/
```

## Migration Checklist

When refactoring to these patterns:

- [ ] Create query key factory in `hooks/use{Feature}Queries.ts`
- [ ] Import `DISABLED_QUERY_KEY` and `STALE_TIMES` from shared
- [ ] Replace all hardcoded disabled keys with `DISABLED_QUERY_KEY`
- [ ] Replace all hardcoded stale times with `STALE_TIMES` constants
- [ ] Update all `queryKey` references to use factory
- [ ] Update all `invalidateQueries` to use factory
- [ ] Update all `setQueryData` to use factory
- [ ] Add comprehensive tests for query keys
- [ ] Remove any backward compatibility code

## Common Pitfalls to Avoid

1. **Don't create centralized query keys** - Each feature owns its keys
2. **Don't hardcode values** - Use shared constants
3. **Don't mix concerns** - Tasks shouldn't import projectKeys
4. **Don't skip mocking in tests** - Mock both services and patterns
5. **Don't use inconsistent patterns** - Follow the established conventions

## Completed Improvements (Phases 1-5)

- ✅ Phase 1: Removed manual frontend ETag cache layer (backend ETags remain; browser-managed)
- ✅ Phase 2: Standardized query keys with factories
- ✅ Phase 3: Implemented UUID-based optimistic updates using nanoid
- ✅ Phase 4: Configured request deduplication
- ✅ Phase 5: Removed manual cache invalidations

## Future Considerations

- Add Server-Sent Events for real-time updates
- Consider WebSocket fallback for critical updates
- Evaluate Zustand for complex client state management