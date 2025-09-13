name: "Decouple Task Priority from Task Order - Implementation-Focused PRP"
description: |

---

## Goal

**Feature Goal**: Decouple task priority from task_order field by implementing a dedicated priority database column and updating all related systems to use separate priority and ordering concepts.

**Deliverable**: 
- New priority database column with proper indexing
- Backend API endpoints updated to handle priority independently from task_order
- Frontend components updated to use dedicated priority field
- Database migration to add priority column and backfill existing data

**Success Definition**: 
- Users can change task priority without affecting drag-and-drop order position
- Users can drag tasks to reorder without changing priority level
- Priority persists correctly in database with dedicated column
- All existing priority functionality continues working identically to user

## User Persona

**Target User**: Project managers and developers using the task management system

**Use Case**: Managing task priorities independently from visual task ordering within status columns

**User Journey**: 
1. User sets task priority to "High" via dropdown/selector
2. User drags task to different position within status column for visual organization
3. Task maintains "High" priority despite position change
4. Priority changes are persisted to database immediately
5. Task order changes are persisted separately from priority

**Pain Points Addressed**: 
- Accidental priority changes when reordering tasks via drag-and-drop
- Inability to maintain semantic priority when organizing tasks visually
- Coupling of two distinct concepts (importance vs. position)

## Why

- **Business Value**: Enables proper task prioritization without visual organization conflicts
- **User Experience**: Eliminates confusion between task importance and visual positioning
- **Data Integrity**: Separates semantic priority from UI ordering concerns
- **System Architecture**: Decouples two distinct business concepts that were incorrectly merged

## What

Implement a dedicated priority system that operates independently from the existing task_order system.

### Success Criteria

- [ ] New priority column added to archon_tasks table with proper indexing
- [ ] Backend API accepts priority field separately from task_order in updates
- [ ] Frontend priority selectors update priority column directly
- [ ] Drag-and-drop operations only affect task_order, never priority
- [ ] Existing tasks backfilled with appropriate priority values based on current task_order
- [ ] Priority changes persist immediately without affecting task position
- [ ] Task reordering works without changing priority values

## All Needed Context

### Context Completeness Check

_This PRP provides all necessary context for implementation including exact file paths, database patterns, API structures, and frontend component patterns from the existing codebase._

### Documentation & References

```yaml
# Database Migration Patterns - MUST FOLLOW
- file: migration/add_source_url_display_name.sql
  why: Perfect example of column addition with indexing, constraints, and backfilling
  pattern: ALTER TABLE with IF NOT EXISTS, index creation, column comments, data backfill
  gotcha: Use IF NOT EXISTS for safe re-execution, include performance indexes

- file: migration/complete_setup.sql
  why: Shows current archon_tasks table structure and existing task_order field
  pattern: Table definition with constraints, enums, and foreign keys
  critical: Lines 380-397 show current schema, task_order INTEGER DEFAULT 0 is the field to decouple from

# Backend API Update Patterns - EXACT STRUCTURE TO FOLLOW
- file: python/src/server/api_routes/projects_api.py
  why: Contains exact Pydantic request model pattern and field processing logic
  pattern: UpdateTaskRequest BaseModel with optional fields, request processing in PUT endpoint
  critical: Lines 766-772 show current UpdateTaskRequest, lines 817-818 show field processing pattern

- file: python/src/server/services/projects/task_service.py
  why: Contains exact service layer update pattern and database interaction
  pattern: update_task method signature, validation methods, Supabase client usage
  critical: Lines 312-368 show complete update flow, validation pattern at lines 340-348

# Frontend Component Patterns - EXISTING IMPLEMENTATION TO MODIFY
- file: archon-ui-main/src/features/projects/tasks/components/TaskCard.tsx
  why: Shows current priority display and change handling using task_order
  pattern: Priority derived via getTaskPriorityFromTaskOrder, handlePriorityChange callback
  critical: Lines 38-39, 62-65 show current coupling to task_order that needs to change

- file: archon-ui-main/src/features/projects/tasks/components/TaskEditModal.tsx
  why: Shows current priority form field implementation using task_order
  pattern: Select component with priority options, state management with setLocalTask
  critical: Lines 134-163 show priority form field that converts to task_order - needs direct priority field

- file: archon-ui-main/src/features/projects/tasks/hooks/useTaskActions.ts
  why: Shows current changePriority implementation that updates task_order
  pattern: changePriority callback that maps priority to task_order values
  critical: Lines 25-38 show coupling logic that needs to update priority field directly

- file: archon-ui-main/src/features/projects/tasks/types/priority.ts
  why: Contains priority type definitions and mapping functions
  pattern: TaskPriority type, TASK_PRIORITY_OPTIONS array, conversion functions
  critical: getTaskPriorityFromTaskOrder function needs to be replaced with direct priority field access
```

### Current Codebase tree (key sections)

```bash
Archon/
├── migration/
│   ├── complete_setup.sql                 # Current DB schema
│   └── add_source_url_display_name.sql    # Migration pattern to follow
├── python/src/server/
│   ├── api_routes/projects_api.py         # API endpoint patterns
│   └── services/projects/task_service.py  # Service layer patterns
└── archon-ui-main/src/features/projects/tasks/
    ├── components/
    │   ├── TaskCard.tsx                   # Priority display component
    │   └── TaskEditModal.tsx              # Priority form component
    ├── hooks/
    │   ├── useTaskActions.ts              # Priority change logic
    │   └── useTaskQueries.ts              # TanStack Query patterns
    └── types/
        └── priority.ts                    # Priority type definitions
```

### Desired Codebase tree with files to be added and responsibility of file

```bash
Archon/
├── migration/
│   └── add_priority_column_to_tasks.sql   # NEW: Database migration for priority column
├── python/src/server/
│   ├── api_routes/projects_api.py         # MODIFY: Add priority field to UpdateTaskRequest
│   └── services/projects/task_service.py  # MODIFY: Add priority validation and database updates
└── archon-ui-main/src/features/projects/tasks/
    ├── components/
    │   ├── TaskCard.tsx                   # MODIFY: Use direct priority field instead of task_order conversion
    │   └── TaskEditModal.tsx              # MODIFY: Update priority form to use direct priority field
    ├── hooks/
    │   └── useTaskActions.ts              # MODIFY: Update changePriority to use direct priority field
    └── types/
        ├── priority.ts                    # MODIFY: Remove task_order conversion functions, add direct priority types
        └── task.ts                       # MODIFY: Add priority field to Task interface
```

### Known Gotchas of our codebase & Library Quirks

```python
# CRITICAL: Supabase client requires exact field names matching database columns
# Example: If database column is 'priority', API must use 'priority' not 'task_priority'

# CRITICAL: TanStack Query optimistic updates must match server response structure
# Example: If server returns priority field, optimistic update must include priority field

# CRITICAL: PostgreSQL enum requires explicit type creation before usage
# Example: CREATE TYPE task_priority AS ENUM ('low', 'medium', 'high', 'urgent');

# CRITICAL: Migration files use IF NOT EXISTS for safe re-execution
# Example: ALTER TABLE archon_tasks ADD COLUMN IF NOT EXISTS priority task_priority DEFAULT 'medium';

# CRITICAL: Frontend priority mapping currently uses TASK_PRIORITY_OPTIONS array
# Example: Must maintain same labels and colors for UI consistency

# CRITICAL: Task ordering uses ORDER_INCREMENT = 1000 for drag-and-drop spacing
# Example: Priority values must not interfere with task_order ranges
```

## Implementation Blueprint

### Data models and structure

Create the priority database column and update type definitions for consistency.

```sql
-- Database: Add priority column with enum type
CREATE TYPE task_priority AS ENUM ('low', 'medium', 'high', 'urgent');
ALTER TABLE archon_tasks ADD COLUMN IF NOT EXISTS priority task_priority DEFAULT 'medium';
CREATE INDEX IF NOT EXISTS idx_archon_tasks_priority ON archon_tasks(priority);

-- Backfill existing data based on current task_order values
UPDATE archon_tasks SET priority = 
  CASE 
    WHEN task_order <= 1 THEN 'urgent'::task_priority
    WHEN task_order <= 25 THEN 'high'::task_priority  
    WHEN task_order <= 50 THEN 'medium'::task_priority
    ELSE 'low'::task_priority
  END
WHERE priority = 'medium';  -- Only update defaults
```

```python
# Backend: Pydantic models
class UpdateTaskRequest(BaseModel):
    title: str | None = None
    description: str | None = None
    status: str | None = None
    assignee: str | None = None
    task_order: int | None = None  # Keep for drag-and-drop ordering
    priority: str | None = None    # NEW: Direct priority field
    feature: str | None = None
```

```typescript
// Frontend: TypeScript interfaces
export interface Task {
  id: string;
  project_id: string;
  title: string;
  description: string;
  status: DatabaseTaskStatus;
  assignee: Assignee;
  task_order: number;  // Keep for drag-and-drop positioning
  priority: TaskPriority;  // NEW: Direct priority field
  feature?: string;
  // ... other fields
}

export type TaskPriority = "low" | "medium" | "high" | "urgent";
```

### Implementation Tasks (ordered by dependencies)

```yaml
Task 1: CREATE migration/add_priority_column_to_tasks.sql
  - IMPLEMENT: Database migration adding priority column with enum type
  - FOLLOW pattern: migration/add_source_url_display_name.sql (header comments, IF NOT EXISTS, indexing)
  - NAMING: add_priority_column_to_tasks.sql
  - INCLUDE: Enum type creation, column addition, index creation, data backfilling
  - PLACEMENT: /migration/ directory alongside other migration files

Task 2: MODIFY python/src/server/api_routes/projects_api.py
  - IMPLEMENT: Add priority field to UpdateTaskRequest Pydantic model
  - FOLLOW pattern: Existing UpdateTaskRequest structure (lines 766-772)
  - ADD: priority: str | None = None to UpdateTaskRequest class
  - ADD: Priority field processing in update endpoint (follow lines 817-818 pattern)
  - PRESERVE: All existing fields and processing logic

Task 3: MODIFY python/src/server/services/projects/task_service.py
  - IMPLEMENT: Add priority validation and database field handling
  - FOLLOW pattern: Existing validate_status and validate_assignee methods
  - ADD: validate_priority method with enum validation
  - ADD: Priority field processing in update_task method (follow lines 340-348 pattern)
  - DEPENDENCIES: Task 1 database migration must be completed first

Task 4: MODIFY archon-ui-main/src/features/projects/tasks/types/priority.ts
  - IMPLEMENT: Remove task_order coupling, add direct priority types
  - REMOVE: getTaskPriorityFromTaskOrder function and task_order dependencies
  - MODIFY: TASK_PRIORITY_OPTIONS to use priority values instead of task_order values
  - PRESERVE: TaskPriority type and visual styling (colors, labels)
  - ADD: Priority validation helpers for frontend

Task 5: MODIFY archon-ui-main/src/features/projects/tasks/types/task.ts
  - IMPLEMENT: Add priority field to Task interface
  - ADD: priority: TaskPriority field to Task interface
  - ADD: priority?: TaskPriority field to UpdateTaskRequest interface
  - FOLLOW pattern: Existing optional field structure
  - PRESERVE: All existing interface fields

Task 6: MODIFY archon-ui-main/src/features/projects/tasks/hooks/useTaskActions.ts
  - IMPLEMENT: Update changePriority to use direct priority field
  - REPLACE: Current task_order mapping logic (lines 25-38) with direct priority updates
  - FOLLOW pattern: Existing updateTaskMutation.mutate structure
  - CHANGE: updates: { priority: newPriority } instead of task_order conversion
  - PRESERVE: All other task action methods

Task 7: MODIFY archon-ui-main/src/features/projects/tasks/components/TaskCard.tsx
  - IMPLEMENT: Use direct priority field instead of task_order conversion
  - REPLACE: getTaskPriorityFromTaskOrder(task.task_order) with task.priority
  - FOLLOW pattern: Existing currentPriority usage and handlePriorityChange
  - PRESERVE: All visual styling, priority indicators, and event handling
  - UPDATE: Priority color mapping to use task.priority directly

Task 8: MODIFY archon-ui-main/src/features/projects/tasks/components/TaskEditModal.tsx
  - IMPLEMENT: Update priority form field to use direct priority
  - REPLACE: task_order conversion logic (lines 134-163) with direct priority field access
  - CHANGE: setLocalTask to update priority field instead of task_order
  - FOLLOW pattern: Existing Select component structure and state management
  - PRESERVE: All form styling, validation, and user experience
```

### Implementation Patterns & Key Details

```python
# Backend Service Pattern - Priority Validation
async def validate_priority(self, priority: str) -> tuple[bool, str]:
    """Validate task priority against allowed enum values"""
    VALID_PRIORITIES = ["low", "medium", "high", "urgent"]
    if priority not in VALID_PRIORITIES:
        return (
            False,
            f"Invalid priority '{priority}'. Must be one of: {', '.join(VALID_PRIORITIES)}",
        )
    return True, ""

# Backend Service Pattern - Update Field Processing
if "priority" in update_fields:
    is_valid, error_msg = self.validate_priority(update_fields["priority"])
    if not is_valid:
        return False, {"error": error_msg}
    update_data["priority"] = update_fields["priority"]
```

```typescript
// Frontend Hook Pattern - Direct Priority Updates
const changePriority = useCallback(
  (taskId: string, newPriority: TaskPriority) => {
    updateTaskMutation.mutate({
      taskId,
      updates: { priority: newPriority },  // Direct field update, no conversion
    });
  },
  [updateTaskMutation],
);

// Frontend Component Pattern - Direct Priority Access
const TaskCard: React.FC<TaskCardProps> = ({ task }) => {
  const currentPriority = task.priority;  // Direct field access, no conversion
  
  return (
    <TaskPriority 
      priority={currentPriority} 
      onPriorityChange={handlePriorityChange}
      isLoading={isUpdating} 
    />
  );
};

// Frontend Form Pattern - Direct Priority Form Field
<Select
  value={localTask?.priority || "medium"}
  onValueChange={(value) => {
    setLocalTask((prev) => 
      prev ? { ...prev, priority: value as TaskPriority } : null
    );
  }}
>
  <SelectItem value="low">Low</SelectItem>
  <SelectItem value="medium">Medium</SelectItem>
  <SelectItem value="high">High</SelectItem>
  <SelectItem value="urgent">Urgent</SelectItem>
</Select>
```

### Integration Points

```yaml
DATABASE:
  - migration: "migration/add_priority_column_to_tasks.sql - Creates priority column with enum type"
  - index: "CREATE INDEX idx_archon_tasks_priority ON archon_tasks(priority) - Performance optimization"
  - backfill: "UPDATE existing tasks based on current task_order mapping"

API_ROUTES:
  - modify: "projects_api.py UpdateTaskRequest - Add priority: str | None = None"
  - processing: "Add priority field processing following existing pattern"

SERVICE_LAYER:
  - modify: "task_service.py - Add validate_priority method and field processing"
  - validation: "Validate priority against enum values [low, medium, high, urgent]"

FRONTEND_TYPES:
  - modify: "Task interface - Add priority: TaskPriority field"
  - modify: "UpdateTaskRequest - Add priority?: TaskPriority field"
  - modify: "Remove task_order coupling from priority.ts"

FRONTEND_COMPONENTS:
  - modify: "TaskCard - Use task.priority instead of getTaskPriorityFromTaskOrder"
  - modify: "TaskEditModal - Update form field to use direct priority"
  - modify: "useTaskActions - Update changePriority to send priority field"
```

## Validation Loop

### Level 1: Syntax & Style (Immediate Feedback)

```bash
# Run after each backend file modification
uv run ruff check python/src/server/ --fix
uv run mypy python/src/server/
uv run ruff format python/src/server/

# Run after each frontend file modification  
cd archon-ui-main
npm run biome:fix
npx tsc --noEmit 2>&1 | grep "src/features"

# Expected: Zero errors. If errors exist, READ output and fix before proceeding.
```

### Level 2: Unit Tests (Component Validation)

```bash
# Backend service tests
uv run pytest python/src/server/services/projects/tests/ -v -k "test_update_task"

# Frontend component tests
cd archon-ui-main
npm run test src/features/projects/tasks/

# Expected: All tests pass. If failing, debug root cause and fix implementation.
```

### Level 3: Integration Testing (System Validation)

```bash
# Database migration validation
psql $DATABASE_URL -f migration/add_priority_column_to_tasks.sql
psql $DATABASE_URL -c "SELECT priority, task_order FROM archon_tasks LIMIT 5;"

# Backend API validation
docker compose up -d
curl -X PUT http://localhost:8181/api/tasks/[task-id] \
  -H "Content-Type: application/json" \
  -d '{"priority": "high"}' \
  | jq .

# Frontend integration validation  
cd archon-ui-main && npm run dev
# Manual test: Change priority in TaskCard, verify TaskEditModal shows correct priority
# Manual test: Drag task to reorder, verify priority unchanged
# Manual test: Change priority in TaskEditModal, verify TaskCard updates

# Expected: Priority changes persist, task_order unaffected, UI updates correctly
```

### Level 4: Creative & Domain-Specific Validation

```bash
# Priority-specific validation scenarios
# Test 1: Create task with priority "high", drag to different position, verify priority unchanged
# Test 2: Set task priority to "urgent", refresh page, verify priority persisted
# Test 3: Update task_order via drag-and-drop, verify priority field unaffected
# Test 4: Bulk update multiple task priorities, verify database consistency

# Database consistency validation
psql $DATABASE_URL -c "
  SELECT priority, task_order, 
    CASE 
      WHEN priority = 'urgent' AND task_order > 50 THEN 'GOOD: Decoupled'
      WHEN priority = 'low' AND task_order <= 25 THEN 'GOOD: Decoupled'
      ELSE 'Validation Result'
    END as decoupling_status
  FROM archon_tasks 
  LIMIT 10;
"

# Performance validation
psql $DATABASE_URL -c "EXPLAIN ANALYZE SELECT * FROM archon_tasks WHERE priority = 'high';"

# Expected: Query uses index, decoupling evident, consistent data integrity
```

## Final Validation Checklist

### Technical Validation

- [ ] Database migration completed successfully: `migration/add_priority_column_to_tasks.sql`
- [ ] All backend tests pass: `uv run pytest python/src/server/ -v`
- [ ] No backend linting errors: `uv run ruff check python/src/server/`
- [ ] No backend type errors: `uv run mypy python/src/server/`
- [ ] All frontend tests pass: `npm run test src/features/projects/tasks/`
- [ ] No frontend type errors: `npx tsc --noEmit`
- [ ] No frontend linting errors: `npm run biome`

### Feature Validation

- [ ] Priority changes via TaskCard dropdown persist to database without affecting task_order
- [ ] Priority changes via TaskEditModal persist to database without affecting task_order  
- [ ] Drag-and-drop task reordering updates task_order without affecting priority
- [ ] New tasks can be created with explicit priority values
- [ ] Existing tasks show correct priority based on backfilled data
- [ ] Priority survives page refreshes and displays consistently
- [ ] All four priority levels (low, medium, high, urgent) work correctly

### Code Quality Validation

- [ ] Backend follows existing service layer patterns for field validation
- [ ] Frontend follows existing component patterns for form fields and state management
- [ ] Database migration follows existing patterns with proper indexing and backfilling
- [ ] Type definitions maintain consistency across backend and frontend
- [ ] No coupling remains between priority display and task_order values
- [ ] Priority field is properly validated at database, API, and frontend levels

### Documentation & Deployment

- [ ] Migration file includes comprehensive comments explaining changes
- [ ] Database schema change documented via column comments
- [ ] Priority enum values clearly defined and consistent across layers
- [ ] No breaking changes to existing drag-and-drop functionality

---

## Anti-Patterns to Avoid

- ❌ Don't modify task_order values when updating priority
- ❌ Don't use task_order ranges to determine priority after migration
- ❌ Don't skip enum type creation in database - use proper PostgreSQL enums
- ❌ Don't forget to backfill existing data during migration
- ❌ Don't hardcode priority values - use enum validation everywhere
- ❌ Don't break existing drag-and-drop functionality by modifying task_order logic
- ❌ Don't forget to update TypeScript types to match database schema changes