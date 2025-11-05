# Agent Work Orders Database Migrations

**Last Updated**: 2025-01-05

This document describes the database migrations for the **Context Engineering Hub** (core Archon) and **Agent Work Orders** (optional automation feature).

---

## Overview

### Context Engineering Hub (Core Archon Feature)
- Template library for workflows, agents, steps, and coding standards
- Stored in core Archon database (`complete_setup.sql`)
- Accessible via MCP server for manual IDE agent usage
- **Always installed** with Archon

### Agent Work Orders (Optional Automation Feature)
- Automated workflow execution using Context Hub templates
- Repository-specific customizations (priming context, coding standards, agent overrides)
- Separate migration file (`agent_work_orders_complete.sql`)
- **Optional** - only install if you want automation

---

## Migration Strategy

### For New Archon Installations

**Step 1**: Run `complete_setup.sql`
- Creates all core Archon tables **including Context Hub**
- Seeds default templates (3 agents, 5 steps, 2 workflows, 3 coding standards)
- Enables Context Hub feature by default

**Step 2 (Optional)**: Run `agent_work_orders_complete.sql`
- Creates AWO automation tables
- Links to Context Hub templates
- Enables AWO feature (disabled by default in Settings)

### For Existing Archon Installations

**Step 1**: Run `migration/0.1.0/012_add_context_hub_tables.sql`
- Adds Context Hub to existing Archon
- Creates template tables with seed data
- Enables Context Hub feature

**Step 2 (Optional)**: Run `agent_work_orders_complete.sql`
- Adds AWO automation capability
- Same as new installations

---

## Migration Files

### `complete_setup.sql` (Core Archon)

**Contains**:
- All Archon core tables (knowledge base, projects, tasks, documents)
- **Context Hub tables**:
  - `archon_agent_templates` - Agent definitions with tools/standards
  - `archon_step_templates` - Workflow steps with type enum
  - `archon_workflow_templates` - Workflow sequences
  - `archon_coding_standards` - Coding standards library
- Seed data: 3 agents, 5 steps, 2 workflows, 3 coding standards
- Feature toggle: `CONTEXT_HUB_ENABLED=true` (default)

**When to run**: New Archon installation

**Usage**:
```bash
# In Supabase SQL Editor:
# 1. Copy entire contents of complete_setup.sql
# 2. Paste in SQL Editor
# 3. Click "Run"
# 4. Verify: SELECT COUNT(*) FROM archon_agent_templates; -- Should return 3
```

### `migration/0.1.0/012_add_context_hub_tables.sql` (Upgrade Migration)

**Contains**:
- Same Context Hub tables as complete_setup.sql
- Designed for existing Archon users upgrading to add Context Hub
- Safe to run (uses IF NOT EXISTS checks)
- Transactional (BEGIN/COMMIT)

**When to run**: Existing Archon installation

**Usage**:
```bash
# In Supabase SQL Editor:
# 1. Copy entire contents of 012_add_context_hub_tables.sql
# 2. Paste in SQL Editor
# 3. Click "Run"
# 4. Restart Archon: docker compose restart
# 5. Enable Context Hub in Settings → Features
```

### `agent_work_orders_complete.sql` (Optional Feature)

**Contains**:
- `archon_configured_repositories` - Repositories using AWO
  - Links to workflow_template_id (Context Hub)
  - Priming context, coding standards, use_template_execution flag
- `archon_repository_agent_overrides` - Agent tool/standard overrides per repo
- `archon_agent_work_orders` - Work orders with selected_steps
- `archon_agent_work_order_steps` - Execution history
- Foreign keys to Context Hub tables
- Feature toggle: `AGENT_WORK_ORDERS_ENABLED=false` (default)

**When to run**: Optional - only if you want AWO automation

**PREREQUISITE**: Context Hub tables must exist (run complete_setup.sql or 012_add_context_hub_tables.sql first)

**Usage**:
```bash
# In Supabase SQL Editor:
# 1. Verify Context Hub tables exist:
SELECT COUNT(*) FROM archon_agent_templates; -- Must return ≥3

# 2. Copy entire contents of agent_work_orders_complete.sql
# 3. Paste in SQL Editor
# 4. Click "Run"
# 5. Start AWO service: uv run python -m uvicorn src.agent_work_orders.server:app --port 8053 --reload
# 6. Enable Agent Work Orders in Settings → Features
```

---

## Migration Execution Order

### New Installation (Complete)
```bash
1. Run: complete_setup.sql (includes Context Hub)
2. Optional: Run agent_work_orders_complete.sql (adds AWO automation)
3. Restart services: docker compose restart
```

### Existing Installation (Incremental)
```bash
1. Run: migration/0.1.0/001-011_*.sql (if not already run)
2. Run: migration/0.1.0/012_add_context_hub_tables.sql (adds Context Hub)
3. Optional: Run agent_work_orders_complete.sql (adds AWO automation)
4. Restart services: docker compose restart
```

---

## Verification Queries

### Context Hub Tables
```sql
-- Verify tables exist
SELECT table_name FROM information_schema.tables
WHERE table_name IN ('archon_agent_templates', 'archon_step_templates',
                     'archon_workflow_templates', 'archon_coding_standards')
ORDER BY table_name;
-- Expected: 4 rows

-- Verify seed data
SELECT COUNT(*) FROM archon_agent_templates; -- Expected: 3
SELECT COUNT(*) FROM archon_step_templates; -- Expected: 5
SELECT COUNT(*) FROM archon_workflow_templates; -- Expected: 2
SELECT COUNT(*) FROM archon_coding_standards; -- Expected: 3

-- List seeded agents
SELECT slug, name FROM archon_agent_templates ORDER BY slug;
-- Expected:
-- code-reviewer | Code Reviewer
-- python-backend-expert | Python Backend Expert
-- react-frontend-specialist | React Frontend Specialist
```

### AWO Tables (If Optional Feature Installed)
```sql
-- Verify tables exist
SELECT table_name FROM information_schema.tables
WHERE table_name IN ('archon_configured_repositories', 'archon_repository_agent_overrides',
                     'archon_agent_work_orders', 'archon_agent_work_order_steps')
ORDER BY table_name;
-- Expected: 4 rows (or 0 if AWO not installed)

-- Check feature toggles
SELECT key, value FROM archon_credentials
WHERE key IN ('CONTEXT_HUB_ENABLED', 'AGENT_WORK_ORDERS_ENABLED')
ORDER BY key;
-- Expected:
-- AGENT_WORK_ORDERS_ENABLED | false
-- CONTEXT_HUB_ENABLED | true
```

---

## Table Relationships

### Context Hub (Core)
```
archon_agent_templates (parent)
    ↓ FK: agent_template_id
archon_step_templates
    ↓ step_template_slug (JSONB reference)
archon_workflow_templates
```

### AWO → Context Hub
```
archon_workflow_templates (Context Hub)
    ↓ FK: workflow_template_id
archon_configured_repositories (AWO)
    ↓ FK: repository_id
archon_agent_work_orders (AWO)
    ↓ FK: agent_work_order_id
archon_agent_work_order_steps (AWO)
```

---

## Configuration

### After Installing Context Hub

1. **Restart Archon services**:
   ```bash
   docker compose restart
   ```

2. **Enable feature in UI** (if upgrading):
   - Navigate to Settings → Features
   - Toggle "Context Hub" ON
   - Navigate to `/context-hub`

3. **Create templates**:
   - Create agent templates (or use seeded defaults)
   - Create step templates with sub-workflows
   - Create workflow templates (must have ≥1 planning/implement/validate)

### After Installing AWO (Optional)

1. **Set environment variable**:
   ```bash
   export STATE_STORAGE_TYPE=supabase
   ```

2. **Start AWO service**:
   ```bash
   uv run python -m uvicorn src.agent_work_orders.server:app --port 8053 --reload
   ```

3. **Enable feature in UI**:
   - Navigate to Settings → Features
   - Toggle "Agent Work Orders" ON
   - Navigate to `/agent-work-orders`

4. **Configure repositories**:
   - Add repository configurations
   - Apply workflow templates
   - Customize priming context and coding standards

---

## Health Checks

### Context Hub
```bash
# Verify tables and seed data
curl http://localhost:8053/api/agent-work-orders/templates/agents | jq
# Expected: 3 agent templates

curl http://localhost:8053/api/agent-work-orders/templates/steps | jq
# Expected: 5 step templates

curl http://localhost:8053/api/agent-work-orders/templates/workflows | jq
# Expected: 2 workflow templates
```

### AWO Service
```bash
# Check service health
curl http://localhost:8053/health | jq

# Expected response includes:
{
  "status": "healthy",
  "storage_type": "supabase",
  "database": {
    "status": "healthy",
    "tables_exist": true
  }
}
```

---

## Rollback Procedures

### Remove Context Hub (NOT RECOMMENDED - Core Feature)
```sql
-- WARNING: This will break Context Hub UI and MCP server

DROP TABLE IF EXISTS archon_coding_standards CASCADE;
DROP TABLE IF EXISTS archon_workflow_templates CASCADE;
DROP TABLE IF EXISTS archon_step_templates CASCADE;
DROP TABLE IF EXISTS archon_agent_templates CASCADE;
DROP TYPE IF EXISTS workflow_step_type CASCADE;

-- Remove feature toggle
DELETE FROM archon_credentials WHERE key = 'CONTEXT_HUB_ENABLED';
```

### Remove AWO (Safe - Optional Feature)
```sql
-- Safe to remove if AWO not being used

DROP TABLE IF EXISTS archon_agent_work_order_steps CASCADE;
DROP TABLE IF EXISTS archon_agent_work_orders CASCADE;
DROP TABLE IF EXISTS archon_repository_agent_overrides CASCADE;
DROP TABLE IF EXISTS archon_configured_repositories CASCADE;

-- Remove feature toggle
DELETE FROM archon_credentials WHERE key = 'AGENT_WORK_ORDERS_ENABLED';
```

---

## Troubleshooting

### "Context Hub tables not found"
**Problem**: Trying to use AWO without Context Hub

**Solution**:
```bash
# Run Context Hub migration first
# For new installations: complete_setup.sql
# For upgrades: 012_add_context_hub_tables.sql
```

### "Foreign key violation" in AWO tables
**Problem**: AWO tables reference Context Hub tables that don't exist

**Solution**: Run Context Hub migrations before AWO migrations

### "Template not found" errors
**Problem**: Seed data didn't load

**Solution**:
```sql
-- Check if agents exist
SELECT COUNT(*) FROM archon_agent_templates;

-- If 0, re-run seed data section from:
-- complete_setup.sql (lines 1482-1540)
-- OR 012_add_context_hub_tables.sql (lines with INSERT statements)
```

---

## Next Steps

After running migrations:

1. **Phase 1**: Build Context Hub UI (backend + frontend)
2. **Phase 2**: Build AWO repository linking (if AWO installed)
3. **Phase 3**: Implement template execution (if AWO installed)

See `PRPs/IMPLEMENTATION_TRACKER.md` for detailed phase checklists.

---

## Migration History

- **complete_setup.sql** - Initial Archon setup (now includes Context Hub)
- **0.1.0/012_add_context_hub_tables.sql** - Add Context Hub to existing installations
- **agent_work_orders_repositories.sql** - Legacy (superseded by agent_work_orders_complete.sql)
- **agent_work_orders_state.sql** - Legacy (superseded by agent_work_orders_complete.sql)
- **agent_work_orders_complete.sql** - Complete AWO setup (consolidates repositories + state)

<!-- EOF -->
