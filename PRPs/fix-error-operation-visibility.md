name: "Fix Error Operation Visibility in Knowledge Base UI"
description: |
  Fix the architectural issue where failed crawl operations disappear from the UI instead of showing error state with retry/remove actions.

---

## Goal

**Feature Goal**: Failed crawl operations must remain visible in the UI with clear error indication and actionable recovery options (retry, remove) instead of silently disappearing after 5-30 seconds.

**Deliverable**:
1. "Failed Operations" section in Knowledge Base UI showing persistent error states
2. Backend API endpoint to retrieve failed operations with extended retention
3. Retry mechanism for failed crawls with original parameters
4. Remove action for explicit user dismissal of failed operations

**Success Definition**:
- When a crawl fails with MemoryError or any error, it appears in "Failed Operations" section
- Error message is clearly displayed with operation details (URL, timestamp, error reason)
- User can click "Retry" to restart crawl with same parameters
- User can click "Remove" to explicitly dismiss the failed operation
- Failed operations persist for 5 minutes (not 30 seconds) before auto-cleanup
- Active operations list excludes failed operations (shown separately)

## User Persona

**Target User**: Archon end user attempting to add knowledge sources

**Use Case**: User adds large documentation site (e.g., docs.mem0.ai/llms.txt) that fails due to memory constraints

**User Journey**:
1. User clicks "Add Knowledge" and enters URL
2. Crawl starts successfully, shows in Active Operations
3. After 8 minutes, crawl fails with MemoryError
4. **CURRENT**: Operation disappears completely from UI
5. **NEW**: Operation moves to "Failed Operations" section with error badge
6. User sees error message: "Crawl failed: Memory usage exceeded threshold for 600.0 seconds"
7. User can click "Retry" to attempt again or "Remove" to dismiss
8. If user does nothing, operation auto-removes after 5 minutes

**Pain Points Addressed**:
- Silent failures with no user visibility
- No way to diagnose why crawl failed
- No recovery path without re-entering URL
- Wasted time re-attempting same failing URLs
- Loss of trust in system reliability

## Why

- **Business Value**: Users can diagnose and recover from failures instead of experiencing silent errors
- **Integration**: Extends existing progress tracking system with persistent error handling
- **Problems Solved**:
  - Issue #801: MemoryError causes operations to disappear
  - User frustration with "black box" failures
  - Support burden from users reporting "disappeared jobs"
  - Data loss when users don't know which URLs failed

## What

### User-Visible Behavior

**Active Operations Section** (existing, no change):
- Shows in-progress crawls (status: starting, analyzing, crawling, processing)
- Stop button to cancel active operations
- Real-time progress percentage and current page

**Failed Operations Section** (NEW):
- Shows operations with status: error, failed
- Red error badge with count (e.g., "Failed (2)")
- Each failed operation displays:
  - Original URL
  - Error icon (red)
  - Error message summary (first 100 chars)
  - Timestamp of failure
  - Action buttons: "View Details", "Retry", "Remove"
- Expandable details showing full error message and crawl logs
- Auto-cleanup after 5 minutes (not 30 seconds)

**Backend Changes**:
- Failed operations persist in backend for 5 minutes (300 seconds)
- New endpoint: `GET /api/progress/?include_failed=true`
- Error state includes original request parameters for retry
- Cleanup delay extended from 30s to 300s for error states

### Success Criteria

- [ ] Failed crawls appear in "Failed Operations" section within 1 second of failure
- [ ] Error message is displayed accurately from backend
- [ ] Retry button restarts crawl with identical parameters
- [ ] Remove button clears operation from UI and backend memory
- [ ] Failed operations auto-remove after 5 minutes
- [ ] Active operations list excludes failed operations
- [ ] Failed operation count badge shows correct number
- [ ] Error details are expandable/collapsible
- [ ] No regression in active operation tracking

## All Needed Context

### Context Completeness Check

✅ **Validation**: An AI agent unfamiliar with Archon can implement this successfully using:
- Exact file paths to existing patterns for error UI, retry logic, and action buttons
- Specific line numbers for backend changes (cleanup delay, API filtering)
- Complete TanStack Query patterns for error handling and cache management
- UI component patterns with styling conventions (glassmorphism, color system)
- Backend progress tracker modification points

### Documentation & References

```yaml
# CRITICAL BACKEND UNDERSTANDING
- file: /mnt/c/Users/Leex279/Documents/GitHub/YouTube/tmp/Archon/tmp/issue-801-analysis.md
  why: Complete root cause analysis of why operations disappear
  critical: |
    - Backend sets error state correctly (line 735-741 of crawling_service.py)
    - ProgressTracker.error() schedules cleanup after 30s (progress_tracker.py:219)
    - Backend API excludes error states from active list (progress_api.py:118)
    - Frontend removes error queries after 5s (useProgressQueries.ts:143)
  pattern: "Understand the complete disappearance sequence before fixing"

- file: /mnt/c/Users/Leex279/Documents/GitHub/YouTube/tmp/Archon/tmp/issue-801-memory-root-cause.md
  why: Understanding why MemoryError occurs helps design retry mechanism
  critical: |
    - MemoryError comes from crawl4ai after 600 seconds above 80% memory
    - Retry should suggest lower CRAWL_MAX_CONCURRENT setting
    - Error message should include memory optimization hints
  pattern: "Use for retry guidance and error message enhancement"

# MUST READ - Frontend Error Handling Patterns
- file: archon-ui-main/src/features/knowledge/components/KnowledgeCard.tsx
  why: Shows existing error display pattern with red edge indicator
  pattern: |
    Lines 35-50: isError prop → red border styling
    className: bg-red-500/10 border-red-500/20
  gotcha: "Use conditional border, not wrapper component"

- file: archon-ui-main/src/features/knowledge/components/KnowledgeList.tsx
  why: Container pattern for list of items with error states
  pattern: |
    Lines 45-89: Maps over items, handles loading/error/empty states
    Empty state uses text-gray-400
  gotcha: "Handle empty failed operations list with helpful message"

- file: archon-ui-main/src/features/progress/components/CrawlingProgress.tsx
  why: Active operations display pattern - adapt for failed operations
  pattern: |
    Lines 1-200: Complete component structure for operation lists
    Shows operation cards with status badges
    Uses smart polling with visibility awareness
  gotcha: "Don't poll failed operations - they're terminal states"

- file: archon-ui-main/src/features/ui/components/DeleteConfirmModal.tsx
  why: Reusable confirmation modal pattern for Remove action
  pattern: |
    Lines 1-150: Type-aware modal with entity-specific messages
    Supports size variants: compact, default, large
    Red destructive styling with glassmorphism
  gotcha: "Use 'knowledge_item' type for failed operation removal"

# MUST READ - Action Button Patterns
- file: archon-ui-main/src/features/knowledge/components/KnowledgeCardActions.tsx
  why: Dropdown action menu pattern for retry/remove buttons
  pattern: |
    Lines 80-180: DropdownMenu with Radix UI primitives
    Ghost button trigger, separators before destructive actions
    Icons from lucide-react, tooltips on buttons
  critical: "Place destructive 'Remove' action after separator at bottom"

- file: archon-ui-main/src/features/knowledge/hooks/useKnowledgeQueries.ts
  why: Mutation patterns for retry and remove operations
  pattern: |
    Lines 100-150: useDeleteKnowledgeItem with optimistic updates
    Lines 200-250: Service layer integration with TanStack Query
    onSuccess invalidates related queries
  gotcha: "Retry is not a mutation - it's re-calling the create source endpoint"

# MUST READ - Progress Tracking & Terminal States
- file: archon-ui-main/src/features/progress/hooks/useProgressQueries.ts
  why: Complete progress polling and cleanup logic
  pattern: |
    Lines 22-23: TERMINAL_STATES = ["completed", "error", "failed", "cancelled"]
    Lines 83-94: refetchInterval stops polling on terminal states
    Lines 136-149: Error cleanup timeout set to 5 seconds
  critical: |
    - PROBLEM: Lines 136-149 auto-remove error queries after 5s
    - FIX: Create separate hook for failed operations that doesn't auto-remove
    - KEEP: Auto-removal for completed/cancelled, REMOVE for error/failed

- file: archon-ui-main/src/features/shared/config/queryPatterns.ts
  why: Shared constants for query configuration
  pattern: |
    Lines 8-15: STALE_TIMES constants
    Line 3: DISABLED_QUERY_KEY for conditional queries
  gotcha: "Use STALE_TIMES.normal (30s) for failed operations list"

- file: archon-ui-main/src/features/shared/hooks/useSmartPolling.ts
  why: Visibility-aware polling for active operations only
  pattern: |
    Lines 1-50: Pauses when tab hidden, slows when unfocused
    Returns refetchInterval for TanStack Query
  gotcha: "Don't use smart polling for failed operations - they're static"

# MUST READ - Backend Progress API
- file: python/src/server/api_routes/progress_api.py
  why: Active operations endpoint that currently excludes errors
  pattern: |
    Lines 18-19: TERMINAL_STATES = {"completed", "failed", "error", "cancelled"}
    Lines 115-118: Filters OUT terminal states from active operations
    Lines 100-152: list_active_operations() endpoint implementation
  critical: |
    CURRENT PROBLEM (Line 118):
    ```python
    if status not in TERMINAL_STATES:  # Excludes error/failed!
        active_operations.append(operation_data)
    ```
    FIX OPTIONS:
    1. Add query param: ?include_failed=true to include failed ops
    2. Create new endpoint: GET /api/progress/failed
    3. Modify filter to include failed but not completed
    RECOMMENDED: Option 1 (query param) for simplicity

- file: python/src/server/utils/progress/progress_tracker.py
  why: Progress state storage and cleanup mechanism
  pattern: |
    Lines 61-73: _delayed_cleanup method with 30s delay
    Lines 196-219: error() method that schedules cleanup
    Lines 163-164: Update method schedules cleanup for failed/cancelled
  critical: |
    CURRENT PROBLEM (Line 61):
    ```python
    async def _delayed_cleanup(cls, progress_id: str, delay_seconds: int = 30):
    ```
    FIX (Line 61):
    ```python
    async def _delayed_cleanup(cls, progress_id: str, delay_seconds: int = 300):
    ```
    OR make delay_seconds configurable per status type

- file: python/src/server/models/progress_models.py
  why: Progress response schema for API
  pattern: Check for existing error field structure
  gotcha: "Error field should include full message, not truncated"

# MUST READ - TanStack Query Error Handling
- file: archon-ui-main/src/features/shared/config/queryClient.ts
  why: Global query client configuration for retries and errors
  pattern: |
    Lines 1-50: Default staleTime, gcTime, retry logic
    Retry disabled for 4xx errors (client errors)
  gotcha: "Failed operations endpoint should return 200, not 404"

- file: archon-ui-main/src/features/shared/utils/optimistic.ts
  why: Optimistic update utilities using nanoid
  pattern: |
    Lines 1-100: createOptimisticEntity, replaceOptimisticEntity
    Uses _optimistic flag and _localId
  gotcha: "Don't need optimistic updates for retry - it's a new operation"

# UI Design System
- file: archon-ui-main/src/features/ui/primitives/
  why: Radix UI primitives used throughout Archon
  pattern: |
    Accordion, AlertDialog, Badge, Button, DropdownMenu
    All styled with glassmorphism and Tron-inspired design
  critical: "Use Badge for failed operation count, AlertDialog for errors"

- docfile: PRPs/ai_docs/UI_STANDARDS.md
  why: Comprehensive UI styling standards
  section: "Section 2: Styling Patterns - Color System, Glassmorphism"
  critical: |
    - Error colors: bg-red-500/10, text-red-400, border-red-500/20
    - Never construct Tailwind classes dynamically
    - Use conditional className strings
  pattern: "Follow glassmorphism pattern with backdrop-blur"

# External Best Practices
- url: https://docs.github.com/en/actions/monitoring-and-troubleshooting-workflows/viewing-workflow-run-history
  why: GitHub Actions failed workflow UI pattern
  critical: |
    - Status badges with icon + text
    - Expandable error logs
    - Retry button prominently placed
    - Clear timestamp and duration
  pattern: "Status badge → Expandable details → Action buttons"

- url: https://vercel.com/docs/deployments/managing-deployments#deployment-states
  why: Vercel deployment states and error handling
  critical: |
    - Failed deployments stay in history
    - Multi-channel notifications (web + email)
    - One-click retry from failed state
  pattern: "Persistent history with retry capability"

- url: https://developer.mozilla.org/en-US/docs/Web/Accessibility/WCAG/Understanding_SC/2_2_1
  why: WCAG 2.1 - Don't auto-dismiss error messages
  critical: "Errors must persist until user acknowledges - NEVER auto-dismiss"
  pattern: "User-controlled dismissal only"
```

### Current Codebase Tree (Relevant Sections)

```bash
archon-ui-main/src/features/
├── knowledge/
│   ├── components/
│   │   ├── KnowledgeCard.tsx          # Has error state pattern (red border)
│   │   ├── KnowledgeCardActions.tsx   # Dropdown action menu pattern
│   │   ├── KnowledgeList.tsx          # List container with states
│   │   └── AddKnowledgeDialog.tsx     # Create knowledge source
│   ├── hooks/
│   │   └── useKnowledgeQueries.ts     # Query/mutation hooks
│   ├── services/
│   │   └── knowledgeService.ts        # API calls
│   └── views/
│       └── KnowledgeView.tsx          # Main view component
├── progress/
│   ├── components/
│   │   └── CrawlingProgress.tsx       # Active operations display
│   ├── hooks/
│   │   └── useProgressQueries.ts      # Progress polling logic
│   └── services/
│       └── progressService.ts         # Progress API calls
└── ui/
    ├── components/
    │   └── DeleteConfirmModal.tsx     # Confirmation modal pattern
    └── primitives/                     # Radix UI components
        ├── Badge.tsx
        ├── Button.tsx
        └── DropdownMenu.tsx

python/src/server/
├── api_routes/
│   └── progress_api.py                # Lines 100-152: list_active_operations
├── utils/progress/
│   └── progress_tracker.py            # Lines 61-73: _delayed_cleanup
├── models/
│   └── progress_models.py             # Progress response schemas
└── services/crawling/
    └── crawling_service.py            # Lines 728-751: Error handling
```

### Desired Codebase Tree (Files to Add/Modify)

```bash
# NEW FILES
archon-ui-main/src/features/progress/components/
└── FailedOperationsSection.tsx        # NEW: Display failed operations with retry/remove

archon-ui-main/src/features/knowledge/hooks/
└── useRetryKnowledgeSource.ts         # NEW: Retry failed crawl mutation

# MODIFIED FILES
archon-ui-main/src/features/progress/hooks/
└── useProgressQueries.ts               # MODIFY: Add useFailedOperations hook

archon-ui-main/src/features/progress/services/
└── progressService.ts                  # MODIFY: Add listFailedOperations method

archon-ui-main/src/features/knowledge/views/
└── KnowledgeView.tsx                   # MODIFY: Add FailedOperationsSection

python/src/server/api_routes/
└── progress_api.py                     # MODIFY: Add ?include_failed param

python/src/server/utils/progress/
└── progress_tracker.py                 # MODIFY: Extend cleanup delay to 300s
```

### Known Gotchas & Library Quirks

```typescript
// CRITICAL: TanStack Query - Auto-removal timing
// Current problem in useProgressQueries.ts:136-149
// Error states are removed after 5 seconds via setTimeout
// This must be DISABLED for failed operations section

// PATTERN: Don't auto-remove error queries
// INSTEAD: Let user explicitly remove via "Remove" button
if (status === "error" || status === "failed") {
  // DON'T DO THIS for failed operations display:
  // setTimeout(() => queryClient.removeQueries(...), 5000)

  // DO THIS instead:
  // Only remove when user clicks "Remove" button
  // Let _delayed_cleanup handle auto-removal after 5 minutes
}

// CRITICAL: Backend cleanup timing
// python/src/server/utils/progress/progress_tracker.py:61
// Default delay_seconds=30 is too short for user visibility
// Change to delay_seconds=300 (5 minutes) for error states

// GOTCHA: Terminal state filtering
// Backend excludes ALL terminal states from active operations
// Need to include failed operations when requested
// Use query parameter: ?include_failed=true

// CRITICAL: Retry mechanism
// Retry is NOT a mutation update - it's creating a new crawl operation
// Must store original request parameters in error state
// Then call knowledge service's create endpoint with same params

// GOTCHA: Radix UI DropdownMenu
// Must wrap DropdownMenuItem with <button> for onClick
// Don't use e.preventDefault() on menu items - breaks keyboard nav

// CRITICAL: Never construct Tailwind classes dynamically
// BAD:  className={`text-${color}-400`}
// GOOD: className={isError ? "text-red-400" : "text-green-400"}

// GOTCHA: Smart polling for static lists
// Failed operations are terminal - don't use useSmartPolling
// Use regular refetchInterval: false or fixed 30s interval
```

## Implementation Blueprint

### Data Models and Structure

```typescript
// archon-ui-main/src/features/progress/types/index.ts
// ADD: Type for failed operation with retry parameters

export interface FailedOperation extends ProgressResponse {
  status: "error" | "failed";
  error: string;                          // Error message
  error_time: string;                     // ISO timestamp
  original_request?: {                    // For retry functionality
    url: string;
    max_depth?: number;
    max_concurrent?: number;
    tags?: string[];
  };
}

export interface FailedOperationsResponse {
  operations: FailedOperation[];
  count: number;
  timestamp: string;
}
```

```python
# python/src/server/models/progress_models.py
# MODIFY: Ensure error field is included in response

class CrawlProgressResponse(BaseProgressResponse):
    """Progress response for crawl operations"""

    # ... existing fields ...

    error: str | None = Field(None, alias="error")              # Error message
    error_time: str | None = Field(None, alias="errorTime")     # ISO timestamp
    error_details: dict[str, Any] | None = Field(None, alias="errorDetails")

    # NEW: Store original request for retry
    original_request: dict[str, Any] | None = Field(None, alias="originalRequest")
```

### Implementation Tasks (Ordered by Dependencies)

```yaml
Task 1: MODIFY python/src/server/utils/progress/progress_tracker.py
  ACTION: Extend cleanup delay for error states from 30s to 300s (5 minutes)
  FILE: python/src/server/utils/progress/progress_tracker.py
  LINES: 61-73, 196-219
  CHANGES:
    - Line 196: Add parameter to error() method: cleanup_delay_seconds: int = 300
    - Line 219: Pass delay to _delayed_cleanup: asyncio.create_task(self._delayed_cleanup(self.progress_id, cleanup_delay_seconds))
    - Line 163-164: Same for update() method when status is failed/cancelled
  WHY: Gives users 5 minutes to see and act on failed operations
  VALIDATION: Check backend logs show "Progress state cleaned up after delay" at 300s not 30s

Task 2: MODIFY python/src/server/services/crawling/crawling_service.py
  ACTION: Store original request parameters in error state for retry
  FILE: python/src/server/services/crawling/crawling_service.py
  LINES: 728-751 (error handling section)
  CHANGES:
    - Line 735-741: Add original_request to progress update
    ```python
    await self._handle_progress_update(
        task_id, {
            "status": "error",
            "progress": error_progress,
            "log": error_message,
            "error": str(e),
            "original_request": {  # NEW: Store for retry
                "url": request.get("url"),
                "max_depth": request.get("max_depth"),
                "max_concurrent": request.get("max_concurrent"),
                "tags": request.get("tags"),
            }
        }
    )
    ```
  WHY: Retry needs original parameters to restart crawl identically
  VALIDATION: Check error state in memory includes original_request field

Task 3: MODIFY python/src/server/api_routes/progress_api.py
  ACTION: Add query parameter to include failed operations
  FILE: python/src/server/api_routes/progress_api.py
  LINES: 100-152 (list_active_operations function)
  CHANGES:
    - Line 101: Add parameter: include_failed: bool = Query(False)
    - Line 118: Modify filter logic:
    ```python
    # OLD: if status not in TERMINAL_STATES:
    # NEW:
    should_include = (
        status not in TERMINAL_STATES or  # Active operations
        (include_failed and status in {"error", "failed"})  # Failed if requested
    )
    if should_include:
        active_operations.append(operation_data)
    ```
  WHY: Frontend can request failed operations separately from active
  VALIDATION: GET /api/progress/?include_failed=true returns failed ops

Task 4: CREATE archon-ui-main/src/features/progress/services/progressService.ts method
  ACTION: Add listFailedOperations method to service
  FILE: archon-ui-main/src/features/progress/services/progressService.ts
  ADD METHOD:
    ```typescript
    async listFailedOperations(): Promise<FailedOperationsResponse> {
      return apiClient.get<FailedOperationsResponse>("/api/progress/", {
        params: { include_failed: "true" }
      });
    }
    ```
  FOLLOW PATTERN: Existing listActiveOperations method
  NAMING: listFailedOperations (consistent with existing naming)
  DEPENDENCIES: Task 3 (backend endpoint supports include_failed param)
  VALIDATION: Service call returns typed FailedOperationsResponse

Task 5: MODIFY archon-ui-main/src/features/progress/hooks/useProgressQueries.ts
  ACTION: Add useFailedOperations hook WITHOUT auto-removal
  FILE: archon-ui-main/src/features/progress/hooks/useProgressQueries.ts
  ADD HOOK (after useActiveOperations):
    ```typescript
    /**
     * Get all failed operations
     * These are NOT auto-removed - user must explicitly dismiss
     */
    export function useFailedOperations() {
      return useQuery<FailedOperationsResponse>({
        queryKey: progressKeys.failed(),
        queryFn: () => progressService.listFailedOperations(),
        enabled: true,
        refetchInterval: 30000,  // Poll every 30s (failed ops are mostly static)
        staleTime: STALE_TIMES.normal,
        // CRITICAL: No auto-removal for failed operations
        // User must explicitly click "Remove" button
      });
    }
    ```
  ADD KEY: progressKeys.failed: () => [...progressKeys.all, "failed"] as const
  WHY: Failed operations need separate query that doesn't auto-remove
  CRITICAL: Do NOT include setTimeout cleanup like lines 136-149
  DEPENDENCIES: Task 4 (service method exists)
  VALIDATION: Hook fetches failed operations, doesn't auto-remove from cache

Task 6: CREATE archon-ui-main/src/features/knowledge/hooks/useRetryKnowledgeSource.ts
  ACTION: Create retry mutation hook
  FILE: archon-ui-main/src/features/knowledge/hooks/useRetryKnowledgeSource.ts
  IMPLEMENT:
    ```typescript
    import { useMutation, useQueryClient } from "@tanstack/react-query";
    import { knowledgeService } from "../services";
    import { progressKeys } from "../../progress/hooks/useProgressQueries";
    import { useToast } from "../../ui/hooks/useToast";
    import type { FailedOperation } from "../../progress/types";

    export function useRetryKnowledgeSource() {
      const queryClient = useQueryClient();
      const { toast } = useToast();

      return useMutation({
        mutationFn: async (failedOp: FailedOperation) => {
          if (!failedOp.original_request?.url) {
            throw new Error("Cannot retry: Original request data missing");
          }

          // Retry by calling create endpoint with original parameters
          return knowledgeService.createSource({
            url: failedOp.original_request.url,
            max_depth: failedOp.original_request.max_depth,
            max_concurrent: failedOp.original_request.max_concurrent,
            tags: failedOp.original_request.tags,
          });
        },

        onSuccess: (data, failedOp) => {
          toast({
            title: "Crawl restarted",
            description: `Retrying crawl for ${failedOp.original_request?.url}`,
          });

          // Remove the failed operation from failed list
          queryClient.removeQueries({
            queryKey: progressKeys.detail(failedOp.progress_id),
            exact: true
          });

          // Refresh both failed and active operations
          queryClient.invalidateQueries({ queryKey: progressKeys.failed() });
          queryClient.invalidateQueries({ queryKey: progressKeys.active() });
        },

        onError: (error) => {
          toast({
            variant: "destructive",
            title: "Retry failed",
            description: error instanceof Error ? error.message : "Could not restart crawl",
          });
        },
      });
    }
    ```
  FOLLOW PATTERN: archon-ui-main/src/features/knowledge/hooks/useKnowledgeQueries.ts (mutation structure)
  NAMING: useRetryKnowledgeSource (matches useCreateKnowledgeSource)
  DEPENDENCIES: Task 5 (progressKeys.failed exists)
  VALIDATION: Calling retry creates new crawl operation, removes from failed list

Task 7: MODIFY archon-ui-main/src/features/progress/hooks/useProgressQueries.ts
  ACTION: Add useRemoveFailedOperation hook
  FILE: archon-ui-main/src/features/progress/hooks/useProgressQueries.ts
  ADD HOOK:
    ```typescript
    /**
     * Remove a failed operation from the list
     * This is explicit user action, not automatic cleanup
     */
    export function useRemoveFailedOperation() {
      const queryClient = useQueryClient();

      return useMutation({
        mutationFn: async (progressId: string) => {
          // Just remove from cache - backend will auto-cleanup after 5 minutes
          // No API call needed - this is client-side dismissal
          return { progressId };
        },

        onSuccess: (_, progressId) => {
          // Remove specific operation
          queryClient.removeQueries({
            queryKey: progressKeys.detail(progressId),
            exact: true
          });

          // Refresh failed operations list
          queryClient.invalidateQueries({ queryKey: progressKeys.failed() });
        },
      });
    }
    ```
  WHY: User can explicitly dismiss failed operations
  PATTERN: Similar to deletion mutations but no API call needed
  DEPENDENCIES: Task 5 (progressKeys.failed exists)
  VALIDATION: Removing operation clears it from failed list immediately

Task 8: CREATE archon-ui-main/src/features/progress/components/FailedOperationsSection.tsx
  ACTION: Create failed operations display component
  FILE: archon-ui-main/src/features/progress/components/FailedOperationsSection.tsx
  IMPLEMENT:
    ```typescript
    import { useState } from "react";
    import { AlertCircle, RotateCcw, X, ChevronDown, ChevronUp } from "lucide-react";
    import { useFailedOperations, useRemoveFailedOperation } from "../hooks/useProgressQueries";
    import { useRetryKnowledgeSource } from "../../knowledge/hooks/useRetryKnowledgeSource";
    import { Badge } from "../../ui/primitives/Badge";
    import { Button } from "../../ui/primitives/Button";
    import { DeleteConfirmModal } from "../../ui/components/DeleteConfirmModal";
    import type { FailedOperation } from "../types";

    export function FailedOperationsSection() {
      const { data: failedOps, isLoading } = useFailedOperations();
      const retryMutation = useRetryKnowledgeSource();
      const removeMutation = useRemoveFailedOperation();
      const [expandedOps, setExpandedOps] = useState<Set<string>>(new Set());
      const [confirmRemove, setConfirmRemove] = useState<FailedOperation | null>(null);

      const toggleExpanded = (progressId: string) => {
        setExpandedOps(prev => {
          const next = new Set(prev);
          if (next.has(progressId)) next.delete(progressId);
          else next.add(progressId);
          return next;
        });
      };

      if (isLoading) return <div className="text-gray-400">Loading failed operations...</div>;
      if (!failedOps?.operations.length) return null;

      return (
        <div className="space-y-4">
          {/* Section Header */}
          <div className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5 text-red-400" />
            <h3 className="text-lg font-semibold text-white">Failed Operations</h3>
            <Badge variant="destructive" className="ml-2">
              {failedOps.count}
            </Badge>
          </div>

          {/* Failed Operations List */}
          <div className="space-y-3">
            {failedOps.operations.map((op) => (
              <div
                key={op.progress_id}
                className="rounded-lg border border-red-500/20 bg-red-500/10 p-4 backdrop-blur-sm"
              >
                {/* Operation Header */}
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <AlertCircle className="h-4 w-4 text-red-400 flex-shrink-0" />
                      <p className="text-sm font-medium text-red-400 truncate">
                        {op.url || op.current_url || "Unknown URL"}
                      </p>
                    </div>
                    <p className="text-xs text-gray-400 mt-1">
                      Failed {new Date(op.error_time || "").toLocaleString()}
                    </p>
                    {/* Error Message Preview */}
                    <p className="text-sm text-gray-300 mt-2 line-clamp-2">
                      {op.error || "Unknown error"}
                    </p>
                  </div>

                  {/* Action Buttons */}
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => toggleExpanded(op.progress_id)}
                      className="text-gray-400 hover:text-white"
                    >
                      {expandedOps.has(op.progress_id) ? (
                        <ChevronUp className="h-4 w-4" />
                      ) : (
                        <ChevronDown className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => retryMutation.mutate(op)}
                      disabled={retryMutation.isPending}
                      className="border-blue-500/20 text-blue-400 hover:bg-blue-500/10"
                    >
                      <RotateCcw className="h-4 w-4 mr-2" />
                      Retry
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setConfirmRemove(op)}
                      className="text-red-400 hover:bg-red-500/10"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                {/* Expanded Error Details */}
                {expandedOps.has(op.progress_id) && (
                  <div className="mt-4 border-t border-red-500/20 pt-4">
                    <h4 className="text-sm font-medium text-gray-300 mb-2">Full Error Message:</h4>
                    <pre className="text-xs text-gray-400 bg-black/20 p-3 rounded overflow-x-auto whitespace-pre-wrap">
                      {op.error}
                    </pre>

                    {op.logs && op.logs.length > 0 && (
                      <>
                        <h4 className="text-sm font-medium text-gray-300 mb-2 mt-4">Crawl Logs:</h4>
                        <div className="space-y-1 max-h-48 overflow-y-auto">
                          {op.logs.slice(-10).map((log: any, idx: number) => (
                            <div key={idx} className="text-xs text-gray-400">
                              <span className="text-gray-500">{new Date(log.timestamp).toLocaleTimeString()}</span>
                              {" - "}
                              {log.message}
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Remove Confirmation Modal */}
          {confirmRemove && (
            <DeleteConfirmModal
              type="knowledge_item"
              itemName={confirmRemove.url || "this operation"}
              onConfirm={() => {
                removeMutation.mutate(confirmRemove.progress_id);
                setConfirmRemove(null);
              }}
              onCancel={() => setConfirmRemove(null)}
            />
          )}
        </div>
      );
    }
    ```
  FOLLOW PATTERNS:
    - CrawlingProgress.tsx for operation list structure
    - KnowledgeCard.tsx for error styling (red border, bg-red-500/10)
    - KnowledgeCardActions.tsx for action buttons
    - DeleteConfirmModal.tsx for remove confirmation
  STYLING:
    - Error container: border-red-500/20 bg-red-500/10
    - Text: text-red-400 for errors, text-gray-300 for normal
    - Glassmorphism: backdrop-blur-sm
  DEPENDENCIES: Tasks 5, 6, 7 (hooks exist)
  VALIDATION: Component displays failed operations with retry/remove buttons

Task 9: MODIFY archon-ui-main/src/features/knowledge/views/KnowledgeView.tsx
  ACTION: Add FailedOperationsSection below active operations
  FILE: archon-ui-main/src/features/knowledge/views/KnowledgeView.tsx
  CHANGES:
    - Import: import { FailedOperationsSection } from "../../progress/components/FailedOperationsSection";
    - Add section after CrawlingProgress component (find existing location)
    - Place between active operations and knowledge sources list
  PATTERN:
    ```tsx
    {/* Active Operations */}
    <CrawlingProgress />

    {/* Failed Operations - NEW */}
    <FailedOperationsSection />

    {/* Knowledge Sources List */}
    <KnowledgeList ... />
    ```
  WHY: Failed operations appear in same view as active operations for visibility
  DEPENDENCIES: Task 8 (FailedOperationsSection component exists)
  VALIDATION: Failed operations section appears in Knowledge Base view

Task 10: ADD archon-ui-main/src/features/progress/types/index.ts types
  ACTION: Add FailedOperation and FailedOperationsResponse types
  FILE: archon-ui-main/src/features/progress/types/index.ts
  ADD TYPES (as shown in Data Models section above):
    - FailedOperation interface
    - FailedOperationsResponse interface
  DEPENDENCIES: None (pure types)
  VALIDATION: TypeScript compiles without errors
```

### Implementation Patterns & Key Details

```typescript
// PATTERN: Failed operations query hook (no auto-removal)
export function useFailedOperations() {
  return useQuery<FailedOperationsResponse>({
    queryKey: progressKeys.failed(),
    queryFn: () => progressService.listFailedOperations(),
    enabled: true,
    refetchInterval: 30000,  // Static polling - failed ops don't change often
    staleTime: STALE_TIMES.normal,
    // CRITICAL: No setTimeout cleanup like error queries
    // User must explicitly click "Remove" button
  });
}

// PATTERN: Retry mutation (restarts crawl with original params)
export function useRetryKnowledgeSource() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: async (failedOp: FailedOperation) => {
      // GOTCHA: Retry is NOT an update - it's a new CREATE
      // Use the original request parameters stored in error state
      if (!failedOp.original_request?.url) {
        throw new Error("Cannot retry: Original request data missing");
      }

      return knowledgeService.createSource(failedOp.original_request);
    },

    onSuccess: (data, failedOp) => {
      // Remove from failed list (new operation will appear in active)
      queryClient.removeQueries({
        queryKey: progressKeys.detail(failedOp.progress_id),
        exact: true
      });

      // PATTERN: Invalidate both lists to ensure UI consistency
      queryClient.invalidateQueries({ queryKey: progressKeys.failed() });
      queryClient.invalidateQueries({ queryKey: progressKeys.active() });
    },
  });
}

// PATTERN: Error display component styling
<div className="rounded-lg border border-red-500/20 bg-red-500/10 p-4 backdrop-blur-sm">
  {/* CRITICAL: Red theme for errors */}
  {/* border-red-500/20 = 20% opacity red border */}
  {/* bg-red-500/10 = 10% opacity red background */}
  {/* backdrop-blur-sm = glassmorphism effect */}

  <div className="flex items-center gap-2">
    <AlertCircle className="h-4 w-4 text-red-400" />
    <p className="text-sm font-medium text-red-400">
      {/* Error text in red-400 */}
    </p>
  </div>
</div>

// PATTERN: Action buttons with appropriate variants
<Button
  variant="outline"
  onClick={() => retryMutation.mutate(op)}
  className="border-blue-500/20 text-blue-400 hover:bg-blue-500/10"
>
  {/* Blue for retry (positive action) */}
  <RotateCcw className="h-4 w-4 mr-2" />
  Retry
</Button>

<Button
  variant="ghost"
  onClick={() => setConfirmRemove(op)}
  className="text-red-400 hover:bg-red-500/10"
>
  {/* Red for remove (destructive action) */}
  <X className="h-4 w-4" />
</Button>
```

```python
# PATTERN: Extended cleanup delay for error states
async def error(self, error_message: str, error_details: dict[str, Any] | None = None, cleanup_delay_seconds: int = 300):
    """
    Mark progress as failed with error information.

    Args:
        error_message: Error message
        error_details: Optional additional error details
        cleanup_delay_seconds: Seconds before cleanup (default 300 = 5 minutes)
    """
    self.state.update({
        "status": "error",
        "error": error_message,
        "error_time": datetime.now().isoformat(),
    })

    if error_details:
        self.state["error_details"] = error_details

    self._update_state()
    safe_logfire_error(
        f"Progress error | progress_id={self.progress_id} | type={self.operation_type} | error={error_message}"
    )

    # CRITICAL: Extended delay for error states (300s vs 30s)
    # Gives users time to see and act on failed operations
    asyncio.create_task(self._delayed_cleanup(self.progress_id, cleanup_delay_seconds))

# PATTERN: Query parameter for including failed operations
@router.get("/")
async def list_active_operations(include_failed: bool = Query(False)):
    """
    List all active operations.

    Args:
        include_failed: If True, include failed/error operations in response
    """
    try:
        logfire.info("Listing active operations")
        active_operations = []

        for op_id, operation in ProgressTracker.list_active().items():
            status = operation.get("status", "unknown")

            # CRITICAL: Include failed operations when requested
            should_include = (
                status not in TERMINAL_STATES or  # Active operations
                (include_failed and status in {"error", "failed"})  # Failed if requested
            )

            if should_include:
                # ... build operation_data ...
                active_operations.append(operation_data)

        # GOTCHA: Return 200 even when no operations (not 404)
        return {
            "operations": active_operations,
            "count": len(active_operations),
            "timestamp": datetime.utcnow().isoformat()
        }
```

### Integration Points

```yaml
FRONTEND ROUTES:
  - no change: /knowledge route already exists
  - component: FailedOperationsSection added to existing KnowledgeView

BACKEND API:
  - modify: GET /api/progress/ to accept ?include_failed=true parameter
  - response: Returns failed operations when include_failed=true

TANSTACK QUERY CACHE:
  - new key: progressKeys.failed() for failed operations list
  - existing keys: progressKeys.active(), progressKeys.detail(id)
  - invalidation: Both failed() and active() after retry

STATE MANAGEMENT:
  - no global state: All state in TanStack Query cache
  - local state: Component-level for expanded operations
  - modal state: Component-level for confirmation dialogs

STYLING:
  - design system: Follow PRPs/ai_docs/UI_STANDARDS.md
  - error colors: bg-red-500/10, text-red-400, border-red-500/20
  - glassmorphism: backdrop-blur-sm on all cards
  - icons: lucide-react (AlertCircle, RotateCcw, X, ChevronDown/Up)
```

## Validation Loop

### Level 1: Syntax & Style (Immediate Feedback)

```bash
# Backend validation
cd python
uv run ruff check src/server/api_routes/progress_api.py --fix
uv run ruff check src/server/utils/progress/progress_tracker.py --fix
uv run ruff check src/server/services/crawling/crawling_service.py --fix
uv run mypy src/server/api_routes/progress_api.py
uv run mypy src/server/utils/progress/progress_tracker.py

# Frontend validation
cd archon-ui-main
npm run biome:fix src/features/progress/
npm run biome:fix src/features/knowledge/hooks/useRetryKnowledgeSource.ts
npx tsc --noEmit 2>&1 | grep "src/features/progress\|src/features/knowledge"

# Expected: Zero errors before proceeding
```

### Level 2: Unit Tests (Component Validation)

```bash
# Backend tests (if test files exist)
cd python
uv run pytest tests/server/api_routes/test_progress_api.py -v -k "test_list_operations"
uv run pytest tests/server/utils/test_progress_tracker.py -v -k "test_error"

# Frontend tests
cd archon-ui-main
npm run test src/features/progress/hooks/useProgressQueries.test.ts
npm run test src/features/progress/components/FailedOperationsSection.test.tsx

# Expected: All existing tests still pass, new tests added and passing
```

### Level 3: Integration Testing (System Validation)

```bash
# Start backend
cd python
docker compose up -d
# OR: uv run python -m src.server.main

# Verify backend API changes
curl -X GET "http://localhost:8181/api/progress/?include_failed=true" | jq .
# Expected: Returns operations with "error" or "failed" status

# Start frontend
cd archon-ui-main
npm run dev

# Manual testing steps:
# 1. Open http://localhost:3737/knowledge
# 2. Click "Add Knowledge" with URL that will fail (e.g., very large site)
# 3. Wait for operation to fail (or stop it manually)
# 4. Verify failed operation appears in "Failed Operations" section
# 5. Click "View Details" - error message should expand
# 6. Click "Retry" - new crawl should start
# 7. Click "Remove" on a failed operation - should show confirmation
# 8. Confirm removal - operation should disappear from list
# 9. Wait 5 minutes - failed operations should auto-cleanup

# Backend logs validation
docker compose logs -f archon-server | grep "Progress state cleaned up after delay"
# Expected: Shows cleanup after 300s (not 30s)

# Query cache validation (Chrome DevTools)
# 1. Open React Query DevTools
# 2. Find ["progress", "failed"] query
# 3. Verify it's not auto-removed after 5 seconds
# 4. Click "Remove" button in UI
# 5. Verify query is removed from cache
```

### Level 4: Accessibility & UX Validation

```bash
# Accessibility validation
cd archon-ui-main

# Run axe-core accessibility tests (if configured)
npm run test:a11y src/features/progress/components/FailedOperationsSection.tsx

# Manual accessibility checks:
# 1. Keyboard navigation: Tab through all buttons, Enter to activate
# 2. Screen reader: NVDA/JAWS announces "Failed Operations, 2 items"
# 3. Error messages: Read in full, not truncated
# 4. Button labels: Clear and descriptive
# 5. Focus indicators: Visible on all interactive elements

# Color contrast validation (WCAG 2.1 AA)
# - Red error text (text-red-400) on dark background: Must be 4.5:1 ratio
# - Use browser dev tools or contrast checker

# Performance validation
# - Failed operations list with 10 items should render in <100ms
# - No memory leaks when operations are removed
# - Chrome DevTools Performance tab: No long tasks

# UX validation checklist:
# [ ] Failed operations are immediately visible (< 1 second after failure)
# [ ] Error messages are readable and helpful
# [ ] Retry button clearly indicates it will restart the crawl
# [ ] Remove requires confirmation (no accidental dismissals)
# [ ] Badge count matches number of failed operations
# [ ] Expandable details work smoothly
# [ ] Operations auto-cleanup after 5 minutes (not intrusive)
```

## Final Validation Checklist

### Technical Validation

- [ ] All 4 validation levels completed successfully
- [ ] Backend tests pass: `uv run pytest tests/server/ -v`
- [ ] Frontend tests pass: `npm run test`
- [ ] No linting errors: `uv run ruff check src/` and `npm run biome`
- [ ] No type errors: `uv run mypy src/` and `npx tsc --noEmit`
- [ ] Backend cleanup delay is 300s (verified in logs)
- [ ] Frontend doesn't auto-remove error queries (verified in DevTools)

### Feature Validation

- [ ] Failed crawls appear in "Failed Operations" section within 1 second
- [ ] Error message displays accurately from backend
- [ ] Retry button starts new crawl with identical parameters
- [ ] Remove button requires confirmation and clears operation
- [ ] Failed operations auto-remove after 5 minutes (not 30 seconds)
- [ ] Active operations list excludes failed operations
- [ ] Failed operation count badge shows correct number
- [ ] Error details expand/collapse smoothly
- [ ] No regression in active operation tracking (existing functionality works)

### Code Quality Validation

- [ ] Follows existing patterns: KnowledgeCard for errors, CrawlingProgress for lists
- [ ] File placement matches desired tree structure
- [ ] Styling matches UI_STANDARDS.md (glassmorphism, error colors)
- [ ] TanStack Query patterns match existing hooks (queryKeys, invalidation)
- [ ] No anti-patterns: No auto-removal for failed ops, no sync in async context
- [ ] Backend uses existing progress tracker patterns
- [ ] Frontend uses existing Radix UI primitives

### User Experience Validation

- [ ] User persona journey is satisfied (see error, retry, remove)
- [ ] Error messages are actionable and clear
- [ ] Retry provides user feedback (toast notification)
- [ ] Remove confirmation prevents accidental dismissal
- [ ] Failed operations persist long enough for users to see (5 minutes)
- [ ] UI is accessible (keyboard navigation, screen reader support)
- [ ] Color contrast meets WCAG 2.1 AA standards

### Documentation & Deployment

- [ ] Code is self-documenting with clear component/function names
- [ ] Error logs are informative: "Progress state cleaned up after delay | progress_id=... | status=error"
- [ ] No new environment variables required
- [ ] Backend changes backward compatible (query param is optional)
- [ ] Frontend changes don't break existing Knowledge Base functionality

---

## Anti-Patterns to Avoid

- ❌ Don't auto-dismiss error states - WCAG violation, user must explicitly dismiss
- ❌ Don't use setTimeout cleanup for failed operations - only for completed/cancelled
- ❌ Don't retry with different parameters - must use original request
- ❌ Don't construct Tailwind classes dynamically - use conditional strings
- ❌ Don't poll failed operations with smart polling - they're static, use fixed interval
- ❌ Don't create new error colors - use existing red-500/10, red-400 system
- ❌ Don't skip confirmation for remove - it's a destructive action
- ❌ Don't return 404 for empty failed operations list - return 200 with empty array
- ❌ Don't modify TERMINAL_STATES constant - it's correct, just change filtering logic
- ❌ Don't create separate backend endpoint - use query parameter on existing endpoint

---

## Confidence Score: 9/10

**Why 9/10:**
- ✅ All patterns exist in codebase and are well-documented
- ✅ Exact file paths and line numbers provided
- ✅ Research covered all necessary areas
- ✅ Implementation is straightforward extension of existing patterns
- ✅ No new libraries or dependencies required
- ✅ Backward compatible changes
- ⚠️ Minor risk: Exact Tailwind class combinations might need adjustment
- ⚠️ Minor risk: DeleteConfirmModal type might need extension

**One-Pass Implementation Likelihood:** Very High (90%)

An AI agent unfamiliar with Archon can implement this successfully using only the PRP and codebase access because:
- All referenced files exist and patterns are proven
- Step-by-step tasks with exact file paths and line numbers
- Complete code examples for all new components
- Clear validation gates at each level
- Comprehensive context about why the problem exists and how to fix it
