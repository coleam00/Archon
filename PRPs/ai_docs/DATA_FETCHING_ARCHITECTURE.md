# Data Fetching Architecture

## Overview

Archon uses **TanStack Query v5** for all data fetching, caching, and synchronization. This replaces the former custom polling layer with a query‑centric design that handles caching, deduplication, and smart refetching (including visibility‑aware polling) automatically.

## Core Components

### 1. Query Client Configuration

**Location**: `archon-ui-main/src/features/shared/config/queryClient.ts`

Centralized QueryClient with:

- 30-second default stale time
- 10-minute garbage collection
- Smart retry logic (skips 4xx errors)
- Request deduplication enabled
- Structural sharing for optimized re-renders

### 2. Smart Polling Hook

**Location**: `archon-ui-main/src/features/ui/hooks/useSmartPolling.ts`

Visibility-aware polling that:

- Pauses when browser tab is hidden
- Slows down (1.5x interval) when tab is unfocused
- Returns `refetchInterval` for use with TanStack Query

### 3. Query Patterns

**Location**: `archon-ui-main/src/features/shared/config/queryPatterns.ts`

Shared constants:

- `DISABLED_QUERY_KEY` - For disabled queries
- `STALE_TIMES` - Standardized cache durations (instant, realtime, frequent, normal, rare, static)

## Feature Implementation Patterns

### Query Key Factories

Each feature maintains its own query keys:

- **Projects**: `archon-ui-main/src/features/projects/hooks/useProjectQueries.ts` (projectKeys)
- **Tasks**: `archon-ui-main/src/features/projects/tasks/hooks/useTaskQueries.ts` (taskKeys)
- **Knowledge**: `archon-ui-main/src/features/knowledge/hooks/useKnowledgeQueries.ts` (knowledgeKeys)
- **Progress**: `archon-ui-main/src/features/progress/hooks/useProgressQueries.ts` (progressKeys)
- **MCP**: `archon-ui-main/src/features/mcp/hooks/useMcpQueries.ts` (mcpKeys)
- **Documents**: `archon-ui-main/src/features/projects/documents/hooks/useDocumentQueries.ts` (documentKeys)

### Data Fetching Hooks

Standard pattern across all features:

- `use[Feature]()` - List queries
- `use[Feature]Detail(id)` - Single item queries
- `useCreate[Feature]()` - Creation mutations
- `useUpdate[Feature]()` - Update mutations
- `useDelete[Feature]()` - Deletion mutations

## Backend Integration

### ETag Support

**Location**: `archon-ui-main/src/features/shared/api/apiClient.ts`

ETag implementation:

- Browser handles ETag headers automatically
- 304 responses reduce bandwidth
- TanStack Query manages cache state

### API Structure

Backend endpoints follow RESTful patterns:

- **Knowledge**: `python/src/server/api_routes/knowledge_api.py`
- **Projects**: `python/src/server/api_routes/projects_api.py`
- **Progress**: `python/src/server/api_routes/progress_api.py`
- **MCP**: `python/src/server/api_routes/mcp_api.py`

## Optimistic Updates

**Utilities**: `archon-ui-main/src/features/shared/utils/optimistic.ts`

All mutations use nanoid-based optimistic updates:

- Creates temporary entities with `_optimistic` flag
- Replaces with server data on success
- Rollback on error
- Visual indicators for pending state

## Refetch Strategies

### Smart Polling Usage

**Implementation**: `archon-ui-main/src/features/ui/hooks/useSmartPolling.ts`

Polling intervals are defined in each feature's query hooks. See actual implementations:
- **Projects**: `archon-ui-main/src/features/projects/hooks/useProjectQueries.ts`
- **Tasks**: `archon-ui-main/src/features/projects/tasks/hooks/useTaskQueries.ts`
- **Knowledge**: `archon-ui-main/src/features/knowledge/hooks/useKnowledgeQueries.ts`
- **Progress**: `archon-ui-main/src/features/progress/hooks/useProgressQueries.ts`
- **MCP**: `archon-ui-main/src/features/mcp/hooks/useMcpQueries.ts`

Standard intervals from `archon-ui-main/src/features/shared/config/queryPatterns.ts`:
- `STALE_TIMES.instant`: 0ms (always fresh)
- `STALE_TIMES.frequent`: 5 seconds (frequently changing data)
- `STALE_TIMES.normal`: 30 seconds (standard cache)

### Manual Refetch

All queries expose `refetch()` for manual updates.

## Performance Optimizations

### Request Deduplication

Handled automatically by TanStack Query when same query key is used.

### Stale Time Configuration

Defined in `STALE_TIMES` and used consistently:

- Auth/Settings: `Infinity` (never stale)
- Active operations: `0` (always fresh)
- Normal data: `30_000` (30 seconds)
- Rare updates: `300_000` (5 minutes)

### Garbage Collection

Unused data removed after 10 minutes (configurable in queryClient).

## Migration from Polling

### What Changed (Phases 1-5)

1. **Phase 1**: Removed ETag cache layer
2. **Phase 2**: Standardized query keys
3. **Phase 3**: Fixed optimistic updates with UUIDs
4. **Phase 4**: Configured request deduplication
5. **Phase 5**: Removed manual invalidations

### Deprecated Patterns

- `usePolling` hook (removed)
- `useCrawlProgressPolling` (removed)
- Manual cache invalidation with setTimeout
- Socket.IO connections
- Double-layer caching

## Testing Patterns

### Hook Testing

**Example**: `archon-ui-main/src/features/projects/hooks/tests/useProjectQueries.test.ts`

Standard mocking approach for:

- Service methods
- Query patterns (STALE_TIMES, DISABLED_QUERY_KEY)
- Smart polling behavior

### Integration Testing

Use React Testing Library with QueryClientProvider wrapper.

## Developer Guidelines

### Adding New Data Fetching

1. Create query key factory in `{feature}/hooks/use{Feature}Queries.ts`
2. Use `useQuery` with appropriate stale time from `STALE_TIMES`
3. Add smart polling if real-time updates needed
4. Implement optimistic updates for mutations
5. Follow existing patterns in similar features

### Common Patterns to Follow

- Always use query key factories
- Never hardcode stale times
- Use `DISABLED_QUERY_KEY` for conditional queries
- Implement optimistic updates for better UX
- Add loading and error states

## Future Considerations

- Server-Sent Events for true real-time (post-Phase 5)
- WebSocket fallback for critical updates
- GraphQL migration for selective field updates
