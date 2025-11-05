---
name: "Phase 0: Database Setup"
description: "SQL migrations for Context Hub (core) and Agent Work Orders (optional)"
phase: 0
dependencies: []
breaking_changes: false
---

## Original Story

```
Create database schema foundation for:
1. Context Engineering Hub - Template library for workflows, agents, steps, coding standards
2. Agent Work Orders - Automated workflow execution with repository-specific overrides

Context Hub is a core Archon feature (included in complete_setup.sql).
Agent Work Orders is optional (separate migration file).
```

## Story Metadata

**Story Type**: Database Setup
**Estimated Complexity**: Low (SQL migrations only)
**Primary Systems Affected**:
- Database: New tables for templates, workflows, repositories, work orders

**Phase Number**: 0
**Dependencies**: None
**Breaking Changes**: ❌ None (additive only)

---

## CRITICAL: Phase 0 is Database Setup ONLY

**What This Phase Does**:
- Creates SQL migration files (already created)
- Documents migration execution process
- Provides verification queries

**What This Phase Does NOT Do**:
- Write any application code
- Create backend services or APIs
- Create frontend UI
- Change existing Archon functionality

**Completion Criteria**: Migrations run successfully in Supabase, seed data loads, all tables verified.

---

## Migration Files (Already Created)

### For New Archon Users
**File**: `migration/complete_setup.sql`
- Contains **all** Archon core tables including Context Hub
- Run this ONE file to get complete Archon instance
- Context Hub tables added at the end:
  - `archon_agent_templates`
  - `archon_step_templates`
  - `archon_workflow_templates`
  - `archon_coding_standards`
- Seeds 3 agents, 5 steps, 2 workflows, 3 coding standards

### For Existing Archon Users
**File**: `migration/0.1.0/012_add_context_hub_tables.sql`
- Adds Context Hub to existing Archon installation
- Same schema as complete_setup.sql addition
- Safe to run (uses IF NOT EXISTS checks)

### For Agent Work Orders (Optional)
**File**: `migration/agent_work_orders_complete.sql`
- Creates AWO automation tables (separate from core)
- Tables:
  - `archon_configured_repositories`
  - `archon_repository_agent_overrides`
  - `archon_agent_work_orders`
  - `archon_agent_work_order_steps`
- Foreign keys to Context Hub templates
- Default: Agent Work Orders feature disabled

---

## Schema Overview

### Context Hub Tables (Core Archon)

**archon_agent_templates**
- Agent definitions with prompts, tools, standards
- Versioned (updates create new versions)
- Examples: Python Backend Expert, React Specialist, Code Reviewer

**archon_step_templates**
- Workflow step templates with step_type enum
- Sub-workflow support via sub_steps JSONB array
- Types: planning, implement, validate, prime, git
- Examples: Standard Planning, Multi-Agent Planning, Standard Review

**archon_workflow_templates**
- Complete workflow sequences
- Must have ≥1 planning, implement, validate step
- Examples: Standard Dev, Fullstack Workflow

**archon_coding_standards**
- Reusable coding standards library
- Language-specific (TypeScript, Python, JavaScript)
- Examples: TypeScript Strict, Python Ruff, React Best Practices

### Agent Work Orders Tables (Optional)

**archon_configured_repositories**
- Repositories using AWO automation
- Links to workflow_template_id (Context Hub)
- Repository-specific: priming_context, coding_standard_ids
- Flag: use_template_execution (default: false)

**archon_repository_agent_overrides**
- Agent tool/standard overrides per repository
- NULL = use template default, JSONB = repository-specific override

**archon_agent_work_orders**
- Work orders with selected_steps (user can toggle steps on/off)
- Execution status, git progress, error tracking

**archon_agent_work_order_steps**
- Step execution history
- Sub-step results tracking

---

## IMPLEMENTATION TASKS

### TASK 1: Verify Migrations Exist

All migration files already created - just verify they exist:

```bash
# Context Hub (core)
ls -l migration/complete_setup.sql
ls -l migration/0.1.0/012_add_context_hub_tables.sql

# Agent Work Orders (optional)
ls -l migration/agent_work_orders_complete.sql
```

**VALIDATE**: All 3 files exist

---

### TASK 2: Run Migrations (New Archon Installation)

If setting up Archon from scratch:

```sql
-- In Supabase SQL Editor:
-- 1. Copy and paste contents of: migration/complete_setup.sql
-- 2. Click "Run"
-- 3. Verify Context Hub tables created (see verification section below)

-- Optional: If using Agent Work Orders
-- 4. Copy and paste contents of: migration/agent_work_orders_complete.sql
-- 5. Click "Run"
-- 6. Verify AWO tables created (see verification section below)
```

**VALIDATE**:
```sql
-- Context Hub tables
SELECT table_name FROM information_schema.tables
WHERE table_name IN ('archon_agent_templates', 'archon_step_templates',
                     'archon_workflow_templates', 'archon_coding_standards')
ORDER BY table_name;
-- Should return 4 rows

-- AWO tables (if agent_work_orders_complete.sql was run)
SELECT table_name FROM information_schema.tables
WHERE table_name LIKE 'archon_%work%order%'
   OR table_name = 'archon_configured_repositories'
   OR table_name = 'archon_repository_agent_overrides'
ORDER BY table_name;
-- Should return 4 rows
```

---

### TASK 3: Run Migrations (Existing Archon Installation)

If upgrading existing Archon:

```sql
-- In Supabase SQL Editor:
-- 1. Copy and paste contents of: migration/0.1.0/012_add_context_hub_tables.sql
-- 2. Click "Run"
-- 3. Verify Context Hub tables created (see verification section)

-- Optional: If using Agent Work Orders
-- 4. Copy and paste contents of: migration/agent_work_orders_complete.sql
-- 5. Click "Run"
-- 6. Verify AWO tables created (see verification section)
```

**VALIDATE**: Same queries as TASK 2

---

### TASK 4: Verify Seed Data

```sql
-- Context Hub seed data
SELECT COUNT(*) FROM archon_agent_templates; -- Should return 3
SELECT COUNT(*) FROM archon_step_templates; -- Should return 5
SELECT COUNT(*) FROM archon_workflow_templates; -- Should return 2
SELECT COUNT(*) FROM archon_coding_standards; -- Should return 3

-- List seeded templates
SELECT slug, name FROM archon_agent_templates ORDER BY slug;
-- Expected:
-- code-reviewer | Code Reviewer
-- python-backend-expert | Python Backend Expert
-- react-frontend-specialist | React Frontend Specialist

SELECT slug, name, step_type FROM archon_step_templates ORDER BY slug;
-- Expected 5 rows with types: planning, implement, validate, prime, git

SELECT slug, name FROM archon_workflow_templates ORDER BY slug;
-- Expected:
-- fullstack-workflow | Fullstack Development Workflow
-- standard-dev | Standard Development Workflow

SELECT slug, language FROM archon_coding_standards ORDER BY slug;
-- Expected:
-- python-ruff | python
-- react-best-practices | javascript
-- typescript-strict | typescript
```

**VALIDATE**: All seed data present

---

### TASK 5: Verify Foreign Keys and Constraints

```sql
-- Verify step templates link to agent templates
SELECT
  st.slug AS step_slug,
  st.step_type,
  at.slug AS agent_slug
FROM archon_step_templates st
LEFT JOIN archon_agent_templates at ON st.agent_template_id = at.id
WHERE st.is_active = TRUE;
-- Should return 5 rows, all with agent_slug populated

-- Verify workflow templates have valid step types
SELECT
  slug,
  jsonb_array_length(steps) AS step_count,
  steps->0->>'step_type' AS first_step_type
FROM archon_workflow_templates
WHERE is_active = TRUE;
-- Should return 2 rows

-- Verify workflow step type enum
SELECT enumlabel FROM pg_enum
WHERE enumtypid = 'workflow_step_type'::regtype
ORDER BY enumlabel;
-- Should return: git, implement, planning, prime, validate
```

**VALIDATE**: All foreign keys and constraints working

---

### TASK 6: Verify Indexes

```sql
-- Check indexes created
SELECT
  tablename,
  indexname
FROM pg_indexes
WHERE tablename LIKE 'archon_%template%'
   OR tablename LIKE 'archon_coding%'
   OR tablename LIKE 'archon_%work%order%'
   OR tablename = 'archon_configured_repositories'
ORDER BY tablename, indexname;
-- Should return multiple indexes for each table
```

**VALIDATE**: All indexes created

---

### TASK 7: Verify Feature Toggles

```sql
-- Check feature settings created
SELECT key, value, category, description
FROM archon_credentials
WHERE key IN ('CONTEXT_HUB_ENABLED', 'AGENT_WORK_ORDERS_ENABLED')
ORDER BY key;
-- Expected:
-- AGENT_WORK_ORDERS_ENABLED | false | features | ...
-- CONTEXT_HUB_ENABLED | true | features | ...
```

**VALIDATE**: Feature toggles exist with correct defaults

---

## Validation Loop

### Level 1: Migration File Existence

```bash
# Verify files exist
test -f migration/complete_setup.sql && echo "✓ complete_setup.sql exists"
test -f migration/0.1.0/012_add_context_hub_tables.sql && echo "✓ 012_add_context_hub_tables.sql exists"
test -f migration/agent_work_orders_complete.sql && echo "✓ agent_work_orders_complete.sql exists"
```

### Level 2: Table Creation

Run appropriate migration files in Supabase SQL Editor, then verify:

```sql
-- Context Hub tables (4 tables)
SELECT COUNT(*) FROM information_schema.tables
WHERE table_name IN ('archon_agent_templates', 'archon_step_templates',
                     'archon_workflow_templates', 'archon_coding_standards');
-- Should return 4

-- AWO tables (4 tables - if agent_work_orders_complete.sql was run)
SELECT COUNT(*) FROM information_schema.tables
WHERE table_name IN ('archon_configured_repositories', 'archon_repository_agent_overrides',
                     'archon_agent_work_orders', 'archon_agent_work_order_steps');
-- Should return 4 (or 0 if AWO not installed)
```

### Level 3: Seed Data Verification

```sql
-- Run queries from TASK 4 above
-- Verify counts match expected values
```

### Level 4: Foreign Key Verification

```sql
-- Run queries from TASK 5 above
-- Verify all joins work correctly
```

### Level 5: Feature Toggle Verification

```sql
-- Run query from TASK 7 above
-- Verify both feature toggles exist
```

---

## COMPLETION CHECKLIST

- [ ] All migration files exist (complete_setup.sql, 012_add_context_hub_tables.sql, agent_work_orders_complete.sql)
- [ ] Migrations run successfully in Supabase (no errors)
- [ ] Context Hub tables created (4 tables)
- [ ] AWO tables created if optional feature desired (4 tables)
- [ ] Seed data loaded successfully (3 agents, 5 steps, 2 workflows, 3 standards)
- [ ] Foreign keys working (step templates → agent templates)
- [ ] Indexes created on all tables
- [ ] Feature toggles created (CONTEXT_HUB_ENABLED, AGENT_WORK_ORDERS_ENABLED)
- [ ] Workflow step type enum created (5 values)
- [ ] All verification queries return expected results
- [ ] DB_UPGRADE_INSTRUCTIONS.md updated with migration 012

---

## Notes

**Migration Strategy:**
- **New Users**: Run `complete_setup.sql` → Get everything including Context Hub
- **Existing Users**: Run `012_add_context_hub_tables.sql` → Add Context Hub to existing Archon
- **Optional**: Run `agent_work_orders_complete.sql` → Add AWO automation feature

**Context Hub vs AWO:**
- Context Hub = Core feature (enabled by default)
- Agent Work Orders = Optional feature (disabled by default)
- Context Hub can be used without AWO (via MCP server for manual IDE usage)
- AWO requires Context Hub (uses templates from Context Hub)

**Feature Toggles:**
- `CONTEXT_HUB_ENABLED` → Default: true (core feature)
- `AGENT_WORK_ORDERS_ENABLED` → Default: false (optional feature)
- Both toggles managed via Settings UI in Phase 1

**No Code Changes:**
- Phase 0 is pure database setup
- No backend services created
- No frontend UI created
- Zero impact on existing Archon functionality

**Dependencies for Next Phases:**
- Phase 1 (Context Hub UI): Requires these tables to exist
- Phase 2 (AWO Foundation): Requires both Context Hub and AWO tables
- Phases 3-6: Build on Phase 2 foundation

**Rollback:**
```sql
-- If needed, drop tables in reverse order:
DROP TABLE IF EXISTS archon_agent_work_order_steps CASCADE;
DROP TABLE IF EXISTS archon_agent_work_orders CASCADE;
DROP TABLE IF EXISTS archon_repository_agent_overrides CASCADE;
DROP TABLE IF EXISTS archon_configured_repositories CASCADE;
DROP TABLE IF EXISTS archon_coding_standards CASCADE;
DROP TABLE IF EXISTS archon_workflow_templates CASCADE;
DROP TABLE IF EXISTS archon_step_templates CASCADE;
DROP TABLE IF EXISTS archon_agent_templates CASCADE;
DROP TYPE IF EXISTS workflow_step_type CASCADE;
```

<!-- EOF -->
