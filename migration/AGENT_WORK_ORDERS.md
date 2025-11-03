# Agent Work Orders Database Migrations

This document describes the database migrations for the Agent Work Orders feature.

## Overview

Agent Work Orders is an optional microservice that executes agent-based workflows using Claude Code CLI. These migrations set up the required database tables for the feature.

## Prerequisites

- Supabase project with the same credentials as main Archon server
- `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` environment variables configured

## Migrations

### 1. `agent_work_orders_repositories.sql`

**Purpose**: Configure GitHub repositories for agent work orders

**Creates**:
- `archon_configured_repositories` table for storing repository configurations
- Indexes for fast repository lookups
- RLS policies for access control
- Validation constraints for repository URLs

**When to run**: Before using the repository configuration feature

**Usage**:
```bash
# Open Supabase dashboard → SQL Editor
# Copy and paste the entire migration file
# Execute
```

### 2. `agent_work_orders_state.sql`

**Purpose**: Persistent state management for agent work orders

**Creates**:
- `archon_agent_work_orders` - Main work order state and metadata table
- `archon_agent_work_order_steps` - Step execution history with foreign key constraints
- Indexes for fast queries (status, repository_url, created_at)
- Database triggers for automatic timestamp management
- RLS policies for service and authenticated access

**Features**:
- ACID guarantees for concurrent work order execution
- Foreign key CASCADE delete (steps deleted when work order deleted)
- Hybrid schema (frequently queried columns + JSONB for flexible metadata)
- Automatic `updated_at` timestamp management

**When to run**: To enable Supabase-backed persistent storage for agent work orders

**Usage**:
```bash
# Open Supabase dashboard → SQL Editor
# Copy and paste the entire migration file
# Execute
```

**Verification**:
```sql
-- Check tables exist
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
AND table_name LIKE 'archon_agent_work_order%';

-- Verify indexes
SELECT tablename, indexname FROM pg_indexes
WHERE tablename LIKE 'archon_agent_work_order%'
ORDER BY tablename, indexname;
```

## Configuration

After applying migrations, configure the agent work orders service:

```bash
# Set environment variable
export STATE_STORAGE_TYPE=supabase

# Restart the service
docker compose restart archon-agent-work-orders
# OR
make agent-work-orders
```

## Health Check

Verify the configuration:

```bash
curl http://localhost:8053/health | jq '{storage_type, database}'
```

Expected response:
```json
{
  "storage_type": "supabase",
  "database": {
    "status": "healthy",
    "tables_exist": true
  }
}
```

## Storage Options

Agent Work Orders supports three storage backends:

1. **Memory** (`STATE_STORAGE_TYPE=memory`) - Default, no persistence
2. **File** (`STATE_STORAGE_TYPE=file`) - Legacy file-based storage
3. **Supabase** (`STATE_STORAGE_TYPE=supabase`) - **Recommended for production**

## Rollback

To remove the agent work orders state tables:

```sql
-- Drop tables (CASCADE will also drop indexes, triggers, and policies)
DROP TABLE IF EXISTS archon_agent_work_order_steps CASCADE;
DROP TABLE IF EXISTS archon_agent_work_orders CASCADE;
```

**Note**: The `update_updated_at_column()` function is shared with other Archon tables and should NOT be dropped.

## Documentation

For detailed setup instructions, see:
- `python/src/agent_work_orders/README.md` - Service configuration guide and migration instructions

## Migration History

- **agent_work_orders_repositories.sql** - Initial repository configuration support
- **agent_work_orders_state.sql** - Supabase persistence migration (replaces file-based storage)
