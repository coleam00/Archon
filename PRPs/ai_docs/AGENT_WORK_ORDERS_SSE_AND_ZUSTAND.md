# Agent Work Orders: SSE + Zustand State Management Standards

## Purpose

This document defines the **complete architecture, patterns, and standards** for implementing Zustand state management with Server-Sent Events (SSE) in the Agent Work Orders feature. It serves as the authoritative reference for:

- State management boundaries (what goes in Zustand vs TanStack Query vs local useState)
- SSE integration patterns and connection management
- Zustand slice organization and naming conventions
- Anti-patterns to avoid
- Migration strategy and implementation plan

**This is a pilot feature** - patterns established here will be applied to other features (Knowledge Base, Projects, Settings).

---

## Current State Analysis

### Component Structure
- **Total Lines:** ~4,400 lines
- **Components:** 10 (RepositoryCard, WorkOrderTable, modals, etc.)
- **Views:** 2 (AgentWorkOrdersView, AgentWorkOrderDetailView)
- **Hooks:** 4 (useAgentWorkOrderQueries, useRepositoryQueries, useWorkOrderLogs, useLogStats)
- **Services:** 2 (agentWorkOrdersService, repositoryService)

### Current State Management (42 useState calls)

**AgentWorkOrdersView (8 state variables):**
```typescript
const [layoutMode, setLayoutMode] = useState<LayoutMode>(getInitialLayoutMode);
const [sidebarExpanded, setSidebarExpanded] = useState(true);
const [showAddRepoModal, setShowAddRepoModal] = useState(false);
const [showEditRepoModal, setShowEditRepoModal] = useState(false);
const [editingRepository, setEditingRepository] = useState<ConfiguredRepository | null>(null);
const [showNewWorkOrderModal, setShowNewWorkOrderModal] = useState(false);
const [searchQuery, setSearchQuery] = useState("");
const selectedRepositoryId = searchParams.get("repo") || undefined;
```

**Problems:**
- Manual localStorage management (layoutMode)
- Prop drilling for modal controls
- No persistence for searchQuery or sidebarExpanded
- Scattered state across multiple useState calls

---

## SSE Architecture (Already Implemented!)

### Backend SSE Streams

**1. Log Stream (✅ Complete)**
```
GET /api/agent-work-orders/{id}/logs/stream
```

**What it provides:**
- Real-time structured logs from workflow execution
- Event types: `workflow_started`, `step_started`, `step_completed`, `workflow_completed`, `workflow_failed`
- Rich metadata in each log: `step`, `step_number`, `total_steps`, `progress`, `progress_pct`, `elapsed_seconds`
- Filters: level, step, since timestamp
- Heartbeat every 15 seconds

**Frontend Integration:**
- ✅ `useWorkOrderLogs` hook - EventSource connection with auto-reconnect
- ✅ `useLogStats` hook - Parses logs to extract progress metrics
- ✅ `RealTimeStats` component - Now uses real SSE data (was mock)
- ✅ `ExecutionLogs` component - Now displays real logs (was mock)

**Key Insight:** SSE logs contain ALL progress information including:
- Current step and progress percentage
- Elapsed time
- Step completion status
- Git stats (from log events)
- Workflow lifecycle events

---

### Current Polling (Should Be Replaced)

**useWorkOrders() - Polls every 3s:**
```typescript
refetchInterval: (query) => {
  const hasActiveWorkOrders = data?.some((wo) => wo.status === "running" || wo.status === "pending");
  return hasActiveWorkOrders ? 3000 : false;
}
```

**useWorkOrder(id) - Polls every 3s:**
```typescript
refetchInterval: (query) => {
  if (data?.status === "running" || data?.status === "pending") {
    return 3000;
  }
  return false;
}
```

**useStepHistory(id) - Polls every 3s:**
```typescript
refetchInterval: (query) => {
  const lastStep = history?.steps[history.steps.length - 1];
  if (lastStep?.step === "create-pr" && lastStep?.success) {
    return false;
  }
  return 3000;
}
```

**Network Impact:**
- 3 active work orders = ~140 HTTP requests/minute
- With ETags: ~50-100KB/minute bandwidth
- Up to 3 second delay for updates

---

## Zustand State Management Standards

### Core Principles

**1. State Categorization:**
- **UI Preferences** → Zustand (persisted)
- **Modal State** → Zustand (NOT persisted)
- **Filter State** → Zustand (persisted)
- **SSE Connections** → Zustand (NOT persisted)
- **Server Data** → TanStack Query (cached)
- **Form State** → Zustand slices OR local useState (depends on complexity)
- **Ephemeral UI** → Local useState (component-specific)

**2. Selective Subscriptions:**
```typescript
// ✅ GOOD - Only re-renders when layoutMode changes
const layoutMode = useAgentWorkOrdersStore((s) => s.layoutMode);
const setLayoutMode = useAgentWorkOrdersStore((s) => s.setLayoutMode);

// ❌ BAD - Re-renders on ANY state change
const { layoutMode, searchQuery, selectedRepositoryId } = useAgentWorkOrdersStore();
```

**3. Server State Boundary:**
```typescript
// ✅ GOOD - TanStack Query for initial load, mutations, caching
const { data: repositories } = useRepositories();

// ✅ GOOD - Zustand for real-time SSE updates
const liveWorkOrder = useAgentWorkOrdersStore((s) => s.liveWorkOrders[id]);

// ✅ GOOD - Combine them
const workOrder = liveWorkOrder || cachedWorkOrder; // SSE overrides cache

// ❌ BAD - Duplicating server state in Zustand
const repositories = useAgentWorkOrdersStore((s) => s.repositories); // DON'T DO THIS
```

**4. Slice Organization:**
- One slice per concern (modals, UI prefs, filters, SSE)
- Each slice is independently testable
- Slices can reference each other via get()
- Use TypeScript for all slice types

---

## Zustand Store Structure

### File Organization
```
src/features/agent-work-orders/state/
├── agentWorkOrdersStore.ts          # Main store combining slices
├── slices/
│   ├── uiPreferencesSlice.ts        # Layout, sidebar state
│   ├── modalsSlice.ts               # Modal visibility & context
│   ├── filtersSlice.ts              # Search, selected repo
│   └── sseSlice.ts                  # SSE connections & live data
└── __tests__/
    └── agentWorkOrdersStore.test.ts # Store tests
```

---

### Main Store (agentWorkOrdersStore.ts)

```typescript
import { create } from 'zustand';
import { persist, devtools, subscribeWithSelector } from 'zustand/middleware';
import { createUIPreferencesSlice, type UIPreferencesSlice } from './slices/uiPreferencesSlice';
import { createModalsSlice, type ModalsSlice } from './slices/modalsSlice';
import { createFiltersSlice, type FiltersSlice } from './slices/filtersSlice';
import { createSSESlice, type SSESlice } from './slices/sseSlice';

/**
 * Combined Agent Work Orders store type
 * Combines all slices into a single store interface
 */
export type AgentWorkOrdersStore =
  & UIPreferencesSlice
  & ModalsSlice
  & FiltersSlice
  & SSESlice;

/**
 * Agent Work Orders global state store
 *
 * Manages:
 * - UI preferences (layout mode, sidebar state) - PERSISTED
 * - Modal state (which modal is open, editing context) - NOT persisted
 * - Filter state (search query, selected repository) - PERSISTED
 * - SSE connections (live updates, connection management) - NOT persisted
 *
 * Does NOT manage:
 * - Server data (TanStack Query handles this)
 * - Ephemeral UI state (local useState for row expansion, etc.)
 */
export const useAgentWorkOrdersStore = create<AgentWorkOrdersStore>()(
  devtools(
    subscribeWithSelector(
      persist(
        (...a) => ({
          ...createUIPreferencesSlice(...a),
          ...createModalsSlice(...a),
          ...createFiltersSlice(...a),
          ...createSSESlice(...a),
        }),
        {
          name: 'agent-work-orders-ui',
          version: 1,
          partialize: (state) => ({
            // Only persist UI preferences and filters
            layoutMode: state.layoutMode,
            sidebarExpanded: state.sidebarExpanded,
            searchQuery: state.searchQuery,
            // Do NOT persist:
            // - Modal state (ephemeral)
            // - SSE connections (must be re-established)
            // - Live data (should be fresh on reload)
          }),
        }
      )
    ),
    { name: 'AgentWorkOrders' }
  )
);
```

---

### UI Preferences Slice

```typescript
// src/features/agent-work-orders/state/slices/uiPreferencesSlice.ts

import { StateCreator } from 'zustand';

export type LayoutMode = 'horizontal' | 'sidebar';

export type UIPreferencesSlice = {
  // State
  layoutMode: LayoutMode;
  sidebarExpanded: boolean;

  // Actions
  setLayoutMode: (mode: LayoutMode) => void;
  setSidebarExpanded: (expanded: boolean) => void;
  toggleSidebar: () => void;
  resetUIPreferences: () => void;
};

/**
 * UI Preferences Slice
 *
 * Manages user interface preferences that should persist across sessions.
 * Includes layout mode (horizontal/sidebar) and sidebar expansion state.
 *
 * Persisted: YES (via persist middleware in main store)
 */
export const createUIPreferencesSlice: StateCreator<
  UIPreferencesSlice,
  [],
  [],
  UIPreferencesSlice
> = (set) => ({
  // Initial state
  layoutMode: 'sidebar',
  sidebarExpanded: true,

  // Actions
  setLayoutMode: (mode) => set({ layoutMode: mode }),

  setSidebarExpanded: (expanded) => set({ sidebarExpanded: expanded }),

  toggleSidebar: () => set((state) => ({ sidebarExpanded: !state.sidebarExpanded })),

  resetUIPreferences: () =>
    set({
      layoutMode: 'sidebar',
      sidebarExpanded: true,
    }),
});
```

**Replaces:**
- Manual localStorage get/set (~20 lines eliminated)
- getInitialLayoutMode, saveLayoutMode functions
- useState for layoutMode and sidebarExpanded

---

### Modals Slice (With Optional Form State)

```typescript
// src/features/agent-work-orders/state/slices/modalsSlice.ts

import { StateCreator } from 'zustand';
import type { ConfiguredRepository } from '../../types/repository';
import type { WorkflowStep } from '../../types';

export type ModalsSlice = {
  // Modal visibility
  showAddRepoModal: boolean;
  showEditRepoModal: boolean;
  showCreateWorkOrderModal: boolean;

  // Modal context (which item is being edited)
  editingRepository: ConfiguredRepository | null;
  preselectedRepositoryId: string | undefined;

  // Actions
  openAddRepoModal: () => void;
  closeAddRepoModal: () => void;
  openEditRepoModal: (repository: ConfiguredRepository) => void;
  closeEditRepoModal: () => void;
  openCreateWorkOrderModal: (repositoryId?: string) => void;
  closeCreateWorkOrderModal: () => void;
  closeAllModals: () => void;
};

/**
 * Modals Slice
 *
 * Manages modal visibility and context (which repository is being edited, etc.).
 * Enables opening modals from anywhere without prop drilling.
 *
 * Persisted: NO (modals should not persist across page reloads)
 *
 * Note: Form state (repositoryUrl, selectedSteps, etc.) can be added to this slice
 * if centralized validation/submission logic is desired. For simple forms that
 * reset on close, local useState in the modal component is cleaner.
 */
export const createModalsSlice: StateCreator<
  ModalsSlice,
  [],
  [],
  ModalsSlice
> = (set) => ({
  // Initial state
  showAddRepoModal: false,
  showEditRepoModal: false,
  showCreateWorkOrderModal: false,
  editingRepository: null,
  preselectedRepositoryId: undefined,

  // Actions
  openAddRepoModal: () => set({ showAddRepoModal: true }),

  closeAddRepoModal: () => set({ showAddRepoModal: false }),

  openEditRepoModal: (repository) =>
    set({
      showEditRepoModal: true,
      editingRepository: repository,
    }),

  closeEditRepoModal: () =>
    set({
      showEditRepoModal: false,
      editingRepository: null,
    }),

  openCreateWorkOrderModal: (repositoryId) =>
    set({
      showCreateWorkOrderModal: true,
      preselectedRepositoryId: repositoryId,
    }),

  closeCreateWorkOrderModal: () =>
    set({
      showCreateWorkOrderModal: false,
      preselectedRepositoryId: undefined,
    }),

  closeAllModals: () =>
    set({
      showAddRepoModal: false,
      showEditRepoModal: false,
      showCreateWorkOrderModal: false,
      editingRepository: null,
      preselectedRepositoryId: undefined,
    }),
});
```

**Replaces:**
- Multiple useState calls for modal visibility (~5 states)
- handleEditRepository, handleCreateWorkOrder helper functions
- Prop drilling for modal open/close callbacks

---

### Filters Slice

```typescript
// src/features/agent-work-orders/state/slices/filtersSlice.ts

import { StateCreator } from 'zustand';

export type FiltersSlice = {
  // State
  searchQuery: string;
  selectedRepositoryId: string | undefined;

  // Actions
  setSearchQuery: (query: string) => void;
  selectRepository: (id: string | undefined, syncUrl?: (id: string | undefined) => void) => void;
  clearFilters: () => void;
};

/**
 * Filters Slice
 *
 * Manages filter and selection state for repositories and work orders.
 * Includes search query and selected repository ID.
 *
 * Persisted: YES (search/selection survives reload)
 *
 * URL Sync: selectedRepositoryId should also update URL query params.
 * Use the syncUrl callback to keep URL in sync.
 */
export const createFiltersSlice: StateCreator<
  FiltersSlice,
  [],
  [],
  FiltersSlice
> = (set) => ({
  // Initial state
  searchQuery: '',
  selectedRepositoryId: undefined,

  // Actions
  setSearchQuery: (query) => set({ searchQuery: query }),

  selectRepository: (id, syncUrl) => {
    set({ selectedRepositoryId: id });
    // Callback to sync with URL search params
    syncUrl?.(id);
  },

  clearFilters: () =>
    set({
      searchQuery: '',
      selectedRepositoryId: undefined,
    }),
});
```

**Replaces:**
- useState for searchQuery
- Manual selectRepository function
- Enables global filtering in future

---

### SSE Slice (Replaces Polling!)

```typescript
// src/features/agent-work-orders/state/slices/sseSlice.ts

import { StateCreator } from 'zustand';
import type { AgentWorkOrder, StepExecutionResult, LogEntry } from '../../types';

export type SSESlice = {
  // Active EventSource connections (keyed by work_order_id)
  logConnections: Map<string, EventSource>;

  // Connection states
  connectionStates: Record<string, 'connecting' | 'connected' | 'error' | 'disconnected'>;

  // Live data from SSE (keyed by work_order_id)
  // This OVERLAYS on top of TanStack Query cached data
  liveLogs: Record<string, LogEntry[]>;
  liveProgress: Record<string, {
    currentStep?: string;
    stepNumber?: number;
    totalSteps?: number;
    progressPct?: number;
    elapsedSeconds?: number;
    status?: string;
  }>;

  // Actions
  connectToLogs: (workOrderId: string) => void;
  disconnectFromLogs: (workOrderId: string) => void;
  handleLogEvent: (workOrderId: string, log: LogEntry) => void;
  clearLogs: (workOrderId: string) => void;
  disconnectAll: () => void;
};

/**
 * SSE Slice
 *
 * Manages Server-Sent Event connections and real-time data from log streams.
 * Handles connection lifecycle, auto-reconnect, and live data aggregation.
 *
 * Persisted: NO (connections must be re-established on page load)
 *
 * Pattern:
 * 1. Component calls connectToLogs(workOrderId) on mount
 * 2. Zustand creates EventSource if not exists
 * 3. Multiple components can subscribe to same connection
 * 4. handleLogEvent parses logs and updates liveProgress
 * 5. Component calls disconnectFromLogs on unmount
 * 6. Zustand closes EventSource when no more subscribers
 */
export const createSSESlice: StateCreator<SSESlice, [], [], SSESlice> = (set, get) => ({
  // Initial state
  logConnections: new Map(),
  connectionStates: {},
  liveLogs: {},
  liveProgress: {},

  // Actions
  connectToLogs: (workOrderId) => {
    const { logConnections, connectionStates } = get();

    // Don't create duplicate connections
    if (logConnections.has(workOrderId)) {
      return;
    }

    // Set connecting state
    set((state) => ({
      connectionStates: {
        ...state.connectionStates,
        [workOrderId]: 'connecting',
      },
    }));

    // Create EventSource for log stream
    const url = `/api/agent-work-orders/${workOrderId}/logs/stream`;
    const eventSource = new EventSource(url);

    eventSource.onopen = () => {
      set((state) => ({
        connectionStates: {
          ...state.connectionStates,
          [workOrderId]: 'connected',
        },
      }));
    };

    eventSource.onmessage = (event) => {
      try {
        const logEntry: LogEntry = JSON.parse(event.data);
        get().handleLogEvent(workOrderId, logEntry);
      } catch (err) {
        console.error('Failed to parse log entry:', err);
      }
    };

    eventSource.onerror = () => {
      set((state) => ({
        connectionStates: {
          ...state.connectionStates,
          [workOrderId]: 'error',
        },
      }));

      // Auto-reconnect after 5 seconds
      setTimeout(() => {
        eventSource.close();
        logConnections.delete(workOrderId);
        get().connectToLogs(workOrderId); // Retry
      }, 5000);
    };

    // Store connection
    logConnections.set(workOrderId, eventSource);
    set({ logConnections: new Map(logConnections) });
  },

  disconnectFromLogs: (workOrderId) => {
    const { logConnections } = get();
    const connection = logConnections.get(workOrderId);

    if (connection) {
      connection.close();
      logConnections.delete(workOrderId);

      set({
        logConnections: new Map(logConnections),
        connectionStates: {
          ...get().connectionStates,
          [workOrderId]: 'disconnected',
        },
      });
    }
  },

  handleLogEvent: (workOrderId, log) => {
    // Add to logs array
    set((state) => ({
      liveLogs: {
        ...state.liveLogs,
        [workOrderId]: [...(state.liveLogs[workOrderId] || []), log].slice(-500), // Keep last 500
      },
    }));

    // Parse log to update progress
    const progressUpdate: any = {};

    if (log.event === 'step_started') {
      progressUpdate.currentStep = log.step;
      progressUpdate.stepNumber = log.step_number;
      progressUpdate.totalSteps = log.total_steps;
    }

    if (log.progress_pct !== undefined) {
      progressUpdate.progressPct = log.progress_pct;
    }

    if (log.elapsed_seconds !== undefined) {
      progressUpdate.elapsedSeconds = log.elapsed_seconds;
    }

    if (log.event === 'workflow_completed') {
      progressUpdate.status = 'completed';
    }

    if (log.event === 'workflow_failed' || log.level === 'error') {
      progressUpdate.status = 'failed';
    }

    if (Object.keys(progressUpdate).length > 0) {
      set((state) => ({
        liveProgress: {
          ...state.liveProgress,
          [workOrderId]: {
            ...state.liveProgress[workOrderId],
            ...progressUpdate,
          },
        },
      }));
    }
  },

  clearLogs: (workOrderId) => {
    set((state) => ({
      liveLogs: {
        ...state.liveLogs,
        [workOrderId]: [],
      },
    }));
  },

  disconnectAll: () => {
    const { logConnections } = get();
    logConnections.forEach((conn) => conn.close());

    set({
      logConnections: new Map(),
      connectionStates: {},
      liveLogs: {},
      liveProgress: {},
    });
  },
});
```

---

## Component Integration Patterns

### Pattern 1: RealTimeStats (SSE + Zustand)

**Current (just fixed):**
```typescript
export function RealTimeStats({ workOrderId }: RealTimeStatsProps) {
  const { logs } = useWorkOrderLogs({ workOrderId }); // Direct SSE hook
  const stats = useLogStats(logs); // Parse logs

  // Display stats.currentStep, stats.progressPct, etc.
}
```

**With Zustand SSE Slice:**
```typescript
export function RealTimeStats({ workOrderId }: RealTimeStatsProps) {
  // Connect to SSE (Zustand manages connection)
  const connectToLogs = useAgentWorkOrdersStore((s) => s.connectToLogs);
  const disconnectFromLogs = useAgentWorkOrdersStore((s) => s.disconnectFromLogs);

  useEffect(() => {
    connectToLogs(workOrderId);
    return () => disconnectFromLogs(workOrderId);
  }, [workOrderId]);

  // Subscribe to parsed progress (Zustand parses logs automatically)
  const progress = useAgentWorkOrdersStore((s) => s.liveProgress[workOrderId]);

  // Display progress.currentStep, progress.progressPct, etc.
  // No need for useLogStats - Zustand already parsed it!
}
```

**Benefits:**
- Zustand handles connection lifecycle
- Multiple components can display progress without multiple connections
- Automatic cleanup when all subscribers unmount

---

### Pattern 2: WorkOrderRow (Hybrid TanStack + Zustand)

**Current:**
```typescript
const { data: workOrder } = useWorkOrder(id); // Polls every 3s
```

**With Zustand:**
```typescript
// Initial load from TanStack Query (cached, no polling)
const { data: cachedWorkOrder } = useWorkOrder(id, {
  refetchInterval: false, // NO MORE POLLING!
});

// Live updates from SSE (via Zustand)
const liveProgress = useAgentWorkOrdersStore((s) => s.liveProgress[id]);

// Merge: SSE overrides cached data
const workOrder = {
  ...cachedWorkOrder,
  ...liveProgress, // status, git_commit_count, etc. from SSE
};
```

**Benefits:**
- No polling (0 HTTP requests while connected)
- Instant updates from SSE
- TanStack Query still handles initial load, mutations, caching

---

### Pattern 3: Modal Management (No Prop Drilling)

**Current:**
```typescript
// AgentWorkOrdersView
const [showEditRepoModal, setShowEditRepoModal] = useState(false);
const [editingRepository, setEditingRepository] = useState<ConfiguredRepository | null>(null);

const handleEditRepository = (repository: ConfiguredRepository) => {
  setEditingRepository(repository);
  setShowEditRepoModal(true);
};

// Pass down to child
<RepositoryCard onEdit={() => handleEditRepository(repository)} />
```

**With Zustand:**
```typescript
// RepositoryCard (no props needed)
const openEditRepoModal = useAgentWorkOrdersStore((s) => s.openEditRepoModal);
<Button onClick={() => openEditRepoModal(repository)}>Edit</Button>

// AgentWorkOrdersView (just renders modal)
const showEditRepoModal = useAgentWorkOrdersStore((s) => s.showEditRepoModal);
const closeEditRepoModal = useAgentWorkOrdersStore((s) => s.closeEditRepoModal);
const editingRepository = useAgentWorkOrdersStore((s) => s.editingRepository);

<EditRepositoryModal
  open={showEditRepoModal}
  onOpenChange={closeEditRepoModal}
  repository={editingRepository}
/>
```

**Benefits:**
- Can open modal from anywhere (breadcrumb, keyboard shortcut, etc.)
- No callback props
- Cleaner component tree

---

## Anti-Patterns (DO NOT DO)

### ❌ Anti-Pattern 1: Subscribing to Full Store
```typescript
// BAD - Component re-renders on ANY state change
const store = useAgentWorkOrdersStore();
const { layoutMode, searchQuery, selectedRepositoryId } = store;
```

**Why bad:**
- Component re-renders even if only unrelated state changes
- Defeats the purpose of Zustand's selective subscriptions

**Fix:**
```typescript
// GOOD - Only re-renders when layoutMode changes
const layoutMode = useAgentWorkOrdersStore((s) => s.layoutMode);
```

---

### ❌ Anti-Pattern 2: Duplicating Server State
```typescript
// BAD - Storing server data in Zustand
type BadSlice = {
  repositories: ConfiguredRepository[];
  workOrders: AgentWorkOrder[];
  isLoadingRepos: boolean;
  fetchRepositories: () => Promise<void>;
};
```

**Why bad:**
- Reimplements TanStack Query (caching, invalidation, optimistic updates)
- Loses Query features (background refetch, deduplication, etc.)
- Increases complexity

**Fix:**
```typescript
// GOOD - TanStack Query for server data
const { data: repositories } = useRepositories();

// GOOD - Zustand ONLY for SSE overlays
const liveUpdates = useAgentWorkOrdersStore((s) => s.liveWorkOrders);
```

---

### ❌ Anti-Pattern 3: Putting Everything in Global State
```typescript
// BAD - Form state in Zustand when it shouldn't be
type BadSlice = {
  addRepoForm: {
    repositoryUrl: string;
    error: string;
    isSubmitting: boolean;
  };
  expandedWorkOrderRows: Set<string>; // Per-row state in global store!
};
```

**Why bad:**
- Clutters global state with component-local concerns
- Forms that reset on close don't need global state
- Row expansion is per-instance, not global

**Fix:**
```typescript
// GOOD - Local useState for simple forms
export function AddRepositoryModal() {
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [error, setError] = useState("");
  // Resets on modal close - perfect for local state
}

// GOOD - Local useState for per-component UI
export function WorkOrderRow() {
  const [isExpanded, setIsExpanded] = useState(false);
  // Each row has its own expansion state
}
```

---

### ❌ Anti-Pattern 4: Using getState() in Render Logic
```typescript
// BAD - Doesn't subscribe to changes
function MyComponent() {
  const layoutMode = useAgentWorkOrdersStore.getState().layoutMode;
  // Component won't re-render when layoutMode changes!
}
```

**Why bad:**
- getState() doesn't create a subscription
- Component won't re-render on state changes
- Silent bugs

**Fix:**
```typescript
// GOOD - Proper subscription
const layoutMode = useAgentWorkOrdersStore((s) => s.layoutMode);
```

---

### ❌ Anti-Pattern 5: Not Cleaning Up SSE Connections
```typescript
// BAD - Connection leaks
useEffect(() => {
  connectToLogs(workOrderId);
  // Missing cleanup!
}, [workOrderId]);
```

**Why bad:**
- EventSource connections stay open forever
- Memory leaks
- Browser connection limit (6 per domain)

**Fix:**
```typescript
// GOOD - Cleanup on unmount
useEffect(() => {
  connectToLogs(workOrderId);
  return () => disconnectFromLogs(workOrderId);
}, [workOrderId]);
```

---

## Implementation Checklist

### Phase 1: Zustand Foundation (Frontend Only)
- [ ] Create `agentWorkOrdersStore.ts` with slice pattern
- [ ] Create `uiPreferencesSlice.ts` (layoutMode, sidebarExpanded)
- [ ] Create `modalsSlice.ts` (modal visibility, editing context)
- [ ] Create `filtersSlice.ts` (searchQuery, selectedRepositoryId)
- [ ] Add persist middleware (only UI prefs and filters)
- [ ] Add devtools middleware
- [ ] Write store tests

**Expected Changes:**
- +350 lines (store + slices)
- -50 lines (remove localStorage boilerplate, helper functions)
- Net: +300 lines

---

### Phase 2: Migrate AgentWorkOrdersView (Frontend Only)
- [ ] Replace useState with Zustand selectors
- [ ] Remove localStorage helper functions (getInitialLayoutMode, saveLayoutMode)
- [ ] Remove modal helper functions (handleEditRepository, etc.)
- [ ] Update modal open/close to use Zustand actions
- [ ] Sync selectedRepositoryId with URL params
- [ ] Test thoroughly (layouts, modals, navigation)

**Expected Changes:**
- AgentWorkOrdersView: -40 lines (400 → 360)
- Eliminate prop drilling for modal callbacks

---

### Phase 3: SSE Integration (Frontend Only)
- [ ] Already done! RealTimeStats now uses real SSE data
- [ ] Already done! ExecutionLogs now displays real logs
- [ ] Verify SSE connection works in browser
- [ ] Check Network tab for `/logs/stream` connection
- [ ] Verify logs appear in real-time

**Expected Changes:**
- None needed - just fixed mock data usage

---

### Phase 4: Remove Polling (Frontend Only)
- [ ] Create `sseSlice.ts` for connection management
- [ ] Add `connectToLogs`, `disconnectFromLogs` actions
- [ ] Add `handleLogEvent` to parse logs and update liveProgress
- [ ] Update RealTimeStats to use Zustand SSE slice
- [ ] Remove `refetchInterval` from `useWorkOrder(id)`
- [ ] Remove `refetchInterval` from `useStepHistory(id)`
- [ ] Remove `refetchInterval` from `useWorkOrders()` (optional - list updates are less critical)
- [ ] Test that status/progress updates appear instantly

**Expected Changes:**
- +150 lines (SSE slice)
- -40 lines (remove polling logic)
- Net: +110 lines

---

### Phase 5: Testing & Documentation
- [ ] Unit tests for all slices
- [ ] Integration test: Create work order → Watch SSE updates → Verify UI updates
- [ ] Test SSE reconnection on connection loss
- [ ] Test multiple components subscribing to same work order
- [ ] Document patterns in this file
- [ ] Update ZUSTAND_STATE_MANAGEMENT.md with agent work orders examples

---

## Testing Standards

### Store Testing
```typescript
// agentWorkOrdersStore.test.ts
import { useAgentWorkOrdersStore } from './agentWorkOrdersStore';

describe('AgentWorkOrdersStore', () => {
  beforeEach(() => {
    // Reset store to initial state
    useAgentWorkOrdersStore.setState({
      layoutMode: 'sidebar',
      sidebarExpanded: true,
      searchQuery: '',
      selectedRepositoryId: undefined,
      showAddRepoModal: false,
      // ... reset all state
    });
  });

  it('should toggle layout mode and persist', () => {
    const { setLayoutMode } = useAgentWorkOrdersStore.getState();
    setLayoutMode('horizontal');

    expect(useAgentWorkOrdersStore.getState().layoutMode).toBe('horizontal');

    // Check localStorage persistence
    const persisted = JSON.parse(localStorage.getItem('agent-work-orders-ui') || '{}');
    expect(persisted.state.layoutMode).toBe('horizontal');
  });

  it('should manage modal state without persistence', () => {
    const { openEditRepoModal, closeEditRepoModal } = useAgentWorkOrdersStore.getState();
    const mockRepo = { id: '1', repository_url: 'https://github.com/test/repo' } as ConfiguredRepository;

    openEditRepoModal(mockRepo);
    expect(useAgentWorkOrdersStore.getState().showEditRepoModal).toBe(true);
    expect(useAgentWorkOrdersStore.getState().editingRepository).toBe(mockRepo);

    closeEditRepoModal();
    expect(useAgentWorkOrdersStore.getState().showEditRepoModal).toBe(false);
    expect(useAgentWorkOrdersStore.getState().editingRepository).toBe(null);

    // Verify modals NOT persisted
    const persisted = JSON.parse(localStorage.getItem('agent-work-orders-ui') || '{}');
    expect(persisted.state.showEditRepoModal).toBeUndefined();
  });

  it('should handle SSE log events and parse progress', () => {
    const { handleLogEvent } = useAgentWorkOrdersStore.getState();
    const workOrderId = 'wo-123';

    const stepStartedLog: LogEntry = {
      work_order_id: workOrderId,
      level: 'info',
      event: 'step_started',
      timestamp: new Date().toISOString(),
      step: 'planning',
      step_number: 2,
      total_steps: 5,
      progress_pct: 40,
    };

    handleLogEvent(workOrderId, stepStartedLog);

    const progress = useAgentWorkOrdersStore.getState().liveProgress[workOrderId];
    expect(progress.currentStep).toBe('planning');
    expect(progress.stepNumber).toBe(2);
    expect(progress.progressPct).toBe(40);
  });
});
```

---

## Performance Expectations

### Current (With Polling)
- **HTTP Requests:** 140/min (3 active work orders)
- **Bandwidth:** 50-100KB/min (with ETags)
- **Latency:** Up to 3 second delay for updates
- **Client CPU:** Moderate (constant polling, re-renders)

### After (With SSE + Zustand)
- **HTTP Requests:** ~14/min (only for mutations and initial loads)
- **SSE Connections:** 1-5 persistent connections
- **Bandwidth:** 5-10KB/min (events only, no 304 overhead)
- **Latency:** <100ms (instant SSE delivery)
- **Client CPU:** Lower (event-driven, selective re-renders)

**Savings: 90% bandwidth reduction, 95% request reduction, instant updates**

---

## Migration Risk Assessment

### Low Risk
- ✅ UI Preferences slice (localStorage → Zustand persist)
- ✅ Modals slice (no external dependencies)
- ✅ SSE logs integration (already built, just use it)

### Medium Risk
- ⚠️ URL sync with Zustand (needs careful testing)
- ⚠️ SSE connection management (need proper cleanup)
- ⚠️ Selective subscriptions (team must learn pattern)

### High Risk (Don't Do)
- ❌ Replacing TanStack Query with Zustand (don't do this!)
- ❌ Global state for all forms (overkill)
- ❌ Putting row expansion in global state (terrible idea)

---

## Decision Matrix: What Goes Where?

| State Type | Current | Should Be | Reason |
|------------|---------|-----------|--------|
| layoutMode | useState + localStorage | Zustand (persisted) | Automatic persistence, global access |
| sidebarExpanded | useState | Zustand (persisted) | Should persist across reloads |
| showAddRepoModal | useState | Zustand (not persisted) | Enable opening from anywhere |
| editingRepository | useState | Zustand (not persisted) | Context for edit modal |
| searchQuery | useState | Zustand (persisted) | Persist search across navigation |
| selectedRepositoryId | URL params | Zustand + URL sync (persisted) | Dual source: Zustand cache + URL truth |
| repositories (server) | TanStack Query | TanStack Query | Perfect for server state |
| workOrders (server) | TanStack Query | TanStack Query + SSE overlay | Initial load (Query), updates (SSE) |
| repositoryUrl (form) | useState in modal | useState in modal | Simple, resets on close |
| selectedSteps (form) | useState in modal | useState in modal | Simple, resets on close |
| isExpanded (row) | useState per row | useState per row | Component-specific |
| SSE connections | useWorkOrderLogs hook | Zustand SSE slice | Centralized management |
| logs (from SSE) | useWorkOrderLogs hook | Zustand SSE slice | Share across components |
| progress (parsed logs) | useLogStats hook | Zustand SSE slice | Auto-parse on event |

---

## Code Examples

### Before: AgentWorkOrdersView (Current)
```typescript
export function AgentWorkOrdersView() {
  // 8 separate useState calls
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(getInitialLayoutMode);
  const [sidebarExpanded, setSidebarExpanded] = useState(true);
  const [showAddRepoModal, setShowAddRepoModal] = useState(false);
  const [showEditRepoModal, setShowEditRepoModal] = useState(false);
  const [editingRepository, setEditingRepository] = useState<ConfiguredRepository | null>(null);
  const [showNewWorkOrderModal, setShowNewWorkOrderModal] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const selectedRepositoryId = searchParams.get("repo") || undefined;

  // Helper functions (20+ lines)
  const updateLayoutMode = (mode: LayoutMode) => {
    setLayoutMode(mode);
    saveLayoutMode(mode); // Manual localStorage
  };

  const handleEditRepository = (repository: ConfiguredRepository) => {
    setEditingRepository(repository);
    setShowEditRepoModal(true);
  };

  // Server data (polls every 3s)
  const { data: repositories = [] } = useRepositories();
  const { data: workOrders = [] } = useWorkOrders(); // Polling!

  // ... 400 lines total
}
```

---

### After: AgentWorkOrdersView (With Zustand)
```typescript
export function AgentWorkOrdersView() {
  const [searchParams, setSearchParams] = useSearchParams();

  // Zustand UI Preferences
  const layoutMode = useAgentWorkOrdersStore((s) => s.layoutMode);
  const sidebarExpanded = useAgentWorkOrdersStore((s) => s.sidebarExpanded);
  const setLayoutMode = useAgentWorkOrdersStore((s) => s.setLayoutMode);
  const toggleSidebar = useAgentWorkOrdersStore((s) => s.toggleSidebar);

  // Zustand Modals
  const showAddRepoModal = useAgentWorkOrdersStore((s) => s.showAddRepoModal);
  const showEditRepoModal = useAgentWorkOrdersStore((s) => s.showEditRepoModal);
  const showCreateWorkOrderModal = useAgentWorkOrdersStore((s) => s.showCreateWorkOrderModal);
  const editingRepository = useAgentWorkOrdersStore((s) => s.editingRepository);
  const openAddRepoModal = useAgentWorkOrdersStore((s) => s.openAddRepoModal);
  const openEditRepoModal = useAgentWorkOrdersStore((s) => s.openEditRepoModal);
  const closeEditRepoModal = useAgentWorkOrdersStore((s) => s.closeEditRepoModal);
  const openCreateWorkOrderModal = useAgentWorkOrdersStore((s) => s.openCreateWorkOrderModal);
  const closeCreateWorkOrderModal = useAgentWorkOrdersStore((s) => s.closeCreateWorkOrderModal);

  // Zustand Filters
  const searchQuery = useAgentWorkOrdersStore((s) => s.searchQuery);
  const selectedRepositoryId = useAgentWorkOrdersStore((s) => s.selectedRepositoryId);
  const setSearchQuery = useAgentWorkOrdersStore((s) => s.setSearchQuery);
  const selectRepository = useAgentWorkOrdersStore((s) => s.selectRepository);

  // Sync Zustand with URL params (bidirectional)
  useEffect(() => {
    const urlRepoId = searchParams.get("repo") || undefined;
    if (urlRepoId !== selectedRepositoryId) {
      selectRepository(urlRepoId, setSearchParams);
    }
  }, [searchParams]);

  // Server data (TanStack Query - NO POLLING after Phase 4)
  const { data: repositories = [] } = useRepositories();
  const { data: cachedWorkOrders = [] } = useWorkOrders({ refetchInterval: false });

  // Live updates from SSE (Phase 4)
  const liveWorkOrders = useAgentWorkOrdersStore((s) => s.liveWorkOrders);
  const workOrders = cachedWorkOrders.map((wo) => ({
    ...wo,
    ...(liveWorkOrders[wo.agent_work_order_id] || {}), // SSE overrides
  }));

  // ... ~360 lines total (-40 lines)
}
```

**Changes:**
- ✅ No manual localStorage (automatic via persist)
- ✅ No helper functions (actions are in store)
- ✅ Can open modals from anywhere
- ✅ No polling (SSE provides updates)
- ❌ More verbose selectors (but clearer intent)

---

## Final Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                  AgentWorkOrdersView                        │
│  ┌────────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ Zustand Store  │  │ TanStack     │  │ Components     │  │
│  │                │  │ Query        │  │                │  │
│  │ ├─ UI Prefs    │  │              │  │ ├─ RepoCard    │  │
│  │ ├─ Modals      │  │ ├─ Repos     │  │ ├─ WorkOrder   │  │
│  │ ├─ Filters     │  │ ├─ WorkOrders│  │ │   Table      │  │
│  │ └─ SSE         │  │ └─ Mutations │  │ └─ Modals      │  │
│  └────────────────┘  └──────────────┘  └────────────────┘  │
│         │                   │                   │           │
│         └───────────────────┴───────────────────┘           │
│                             │                               │
└─────────────────────────────┼───────────────────────────────┘
                              │
                ┌─────────────┴─────────────┐
                │                           │
         ┌──────▼──────┐            ┌──────▼──────┐
         │   Backend   │            │   Backend   │
         │  REST API   │            │ SSE Stream  │
         │             │            │             │
         │ GET /repos  │            │ GET /logs/  │
         │ POST /wo    │            │    stream   │
         │ PATCH /repo │            │             │
         └─────────────┘            └─────────────┘
```

**Data Flow:**
1. **Initial Load:** TanStack Query → REST API → Cache
2. **Real-Time Updates:** SSE Stream → Zustand SSE Slice → Components
3. **User Actions:** Component → Zustand Action → TanStack Query Mutation → REST API
4. **UI State:** Component → Zustand Selector → Render

---

## Summary

### Use Zustand For:
1. ✅ **UI Preferences** (layoutMode, sidebarExpanded) - Persisted
2. ✅ **Modal State** (visibility, editing context) - NOT persisted
3. ✅ **Filter State** (search, selected repo) - Persisted
4. ✅ **SSE Management** (connections, live data parsing) - NOT persisted

### Use Zustand Slices For:
1. ✅ **Modals** - Clean separation, no prop drilling
2. ✅ **UI Preferences** - Persistence with minimal code
3. ✅ **SSE** - Connection lifecycle management
4. ⚠️ **Forms** - Only if complex validation or "save draft" needed
5. ❌ **Ephemeral UI** - Keep local useState for row expansion, etc.

### Keep TanStack Query For:
1. ✅ **Server Data** - Initial loads, caching, mutations
2. ✅ **Optimistic Updates** - TanStack Query handles this perfectly
3. ✅ **Request Deduplication** - Built-in
4. ✅ **Background Refetch** - For completed work orders (no SSE needed)

### Keep Local useState For:
1. ✅ **Simple Forms** - Reset on close, no sharing needed
2. ✅ **Ephemeral UI** - Row expansion, animation triggers
3. ✅ **Component-Specific** - showLogs toggle in RealTimeStats

---

## Expected Outcomes

### Code Metrics
- **Current:** 4,400 lines
- **After Phase 4:** 4,890 lines (+490 lines / +11%)
- **Net Change:** +350 Zustand, +200 SSE, -60 removed boilerplate

### Performance Metrics
- **HTTP Requests:** 140/min → 14/min (-90%)
- **Bandwidth:** 50-100KB/min → 5-10KB/min (-90%)
- **Update Latency:** 3 seconds → <100ms (-97%)
- **Client Re-renders:** Reduced (selective subscriptions)

### Developer Experience
- ✅ No manual localStorage management
- ✅ No prop drilling for modals
- ✅ Truly real-time updates (SSE)
- ✅ Better debugging (Zustand DevTools)
- ⚠️ Slightly more verbose (selective subscriptions)
- ⚠️ Learning curve (Zustand patterns, SSE lifecycle)

**Verdict: Net positive - real-time architecture is worth the 11% code increase**

---

## Next Steps

**DO NOT IMPLEMENT YET - This document is the reference for creating a PRP.**

When creating the PRP:
1. Reference this document for architecture decisions
2. Follow the 5-phase implementation plan
3. Include all anti-patterns as validation gates
4. Add comprehensive test requirements
5. Document Zustand + SSE patterns for other features to follow

This is a **pilot feature** - success here validates the pattern for Knowledge Base, Projects, and Settings.
