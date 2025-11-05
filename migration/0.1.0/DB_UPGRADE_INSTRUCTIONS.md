# Archon Database Migrations

This folder contains database migration scripts for upgrading existing Archon installations.

## Available Migration Scripts

### 1. `backup_database.sql` - Pre-Migration Backup
**Always run this FIRST before any migration!**

Creates timestamped backup tables of all your existing data:
- ✅ Complete backup of `archon_crawled_pages`
- ✅ Complete backup of `archon_code_examples` 
- ✅ Complete backup of `archon_sources`
- ✅ Easy restore commands provided
- ✅ Row count verification

### 2. Migration Scripts (Run in Order)

You only have to run the ones you haven't already! If you don't remember exactly, it is okay to rerun migration scripts.

**2.1. `001_add_source_url_display_name.sql`**
- Adds display name field to sources table
- Improves UI presentation of crawled sources

**2.2. `002_add_hybrid_search_tsvector.sql`**
- Adds full-text search capabilities
- Implements hybrid search with tsvector columns
- Creates optimized search indexes

**2.3. `003_ollama_add_columns.sql`**
- Adds multi-dimensional embedding columns (384, 768, 1024, 1536, 3072 dimensions)
- Adds model tracking fields (`llm_chat_model`, `embedding_model`, `embedding_dimension`)

**2.4. `004_ollama_migrate_data.sql`**
- Migrates existing embeddings to new multi-dimensional columns
- Drops old embedding column after migration
- Removes obsolete indexes

**2.5. `005_ollama_create_functions.sql`**
- Creates search functions for multi-dimensional embeddings
- Adds helper functions for dimension detection
- Maintains backward compatibility with legacy search functions

**2.6. `006_ollama_create_indexes_optional.sql`**
- Creates vector indexes for performance (may timeout on large datasets)
- Creates B-tree indexes for model fields
- Can be skipped if timeout occurs (system will use brute-force search)

**2.7. `007_add_priority_column_to_tasks.sql`**
- Adds priority field to tasks table
- Enables task prioritization in project management

**2.8. `008_add_migration_tracking.sql`**
- Creates migration tracking table
- Records all applied migrations
- Enables migration version control

**2.9. `009_add_cascade_delete_constraints.sql`**
- Adds cascade delete constraints to maintain referential integrity
- Ensures cleanup of related records when parent records are deleted

**2.10. `010_add_provider_placeholders.sql`**
- Adds provider-related columns for multi-provider support
- Prepares database for future provider flexibility

**2.11. `011_add_page_metadata_table.sql`**
- Creates page metadata tracking table
- Improves crawl page tracking and organization

**2.12. `012_add_context_hub_tables.sql`** ⭐ NEW FEATURE
- Adds Context Engineering Hub feature to Archon
- Creates template tables: agent_templates, step_templates, workflow_templates, coding_standards
- Enables template management for workflows, agents, and coding standards
- Seeds 3 agent templates, 5 step templates, 2 workflows, 3 coding standards
- **Feature Toggle**: Enabled by default in Settings → Features

## Migration Process (Follow This Order!)

### Step 1: Backup Your Data
```sql
-- Run: backup_database.sql
-- This creates timestamped backup tables of all your data
```

### Step 2: Run All Migration Scripts (In Order!)
```sql
-- Run each script in sequence:
-- 1. Run: 001_add_source_url_display_name.sql
-- 2. Run: 002_add_hybrid_search_tsvector.sql
-- 3. Run: 003_ollama_add_columns.sql
-- 4. Run: 004_ollama_migrate_data.sql
-- 5. Run: 005_ollama_create_functions.sql
-- 6. Run: 006_ollama_create_indexes_optional.sql (optional - may timeout)
-- 7. Run: 007_add_priority_column_to_tasks.sql
-- 8. Run: 008_add_migration_tracking.sql
-- 9. Run: 009_add_cascade_delete_constraints.sql
-- 10. Run: 010_add_provider_placeholders.sql
-- 11. Run: 011_add_page_metadata_table.sql
-- 12. Run: 012_add_context_hub_tables.sql ⭐ NEW FEATURE
```

### Step 3: Restart Services
```bash
docker compose restart
```

## How to Run Migrations

### Method 1: Using Supabase Dashboard (Recommended)
1. Open your Supabase project dashboard
2. Go to **SQL Editor**
3. Copy and paste the contents of the migration file
4. Click **Run** to execute the migration
5. **Important**: Supabase only shows the result of the last query - all our scripts end with a status summary table that shows the complete results

### Method 2: Using psql Command Line
```bash
# Connect to your database
psql -h your-supabase-host -p 5432 -U postgres -d postgres

# Run the migrations in order
\i /path/to/001_add_source_url_display_name.sql
\i /path/to/002_add_hybrid_search_tsvector.sql
\i /path/to/003_ollama_add_columns.sql
\i /path/to/004_ollama_migrate_data.sql
\i /path/to/005_ollama_create_functions.sql
\i /path/to/006_ollama_create_indexes_optional.sql
\i /path/to/007_add_priority_column_to_tasks.sql
\i /path/to/008_add_migration_tracking.sql
\i /path/to/009_add_cascade_delete_constraints.sql
\i /path/to/010_add_provider_placeholders.sql
\i /path/to/011_add_page_metadata_table.sql
\i /path/to/012_add_context_hub_tables.sql

# Exit
\q
```

### Method 3: Using Docker (if using local Supabase)
```bash
# Copy migrations to container
docker cp 001_add_source_url_display_name.sql supabase-db:/tmp/
docker cp 002_add_hybrid_search_tsvector.sql supabase-db:/tmp/
docker cp 003_ollama_add_columns.sql supabase-db:/tmp/
docker cp 004_ollama_migrate_data.sql supabase-db:/tmp/
docker cp 005_ollama_create_functions.sql supabase-db:/tmp/
docker cp 006_ollama_create_indexes_optional.sql supabase-db:/tmp/
docker cp 007_add_priority_column_to_tasks.sql supabase-db:/tmp/
docker cp 008_add_migration_tracking.sql supabase-db:/tmp/
docker cp 009_add_cascade_delete_constraints.sql supabase-db:/tmp/
docker cp 010_add_provider_placeholders.sql supabase-db:/tmp/
docker cp 011_add_page_metadata_table.sql supabase-db:/tmp/
docker cp 012_add_context_hub_tables.sql supabase-db:/tmp/

# Execute migrations in order
docker exec -it supabase-db psql -U postgres -d postgres -f /tmp/001_add_source_url_display_name.sql
docker exec -it supabase-db psql -U postgres -d postgres -f /tmp/002_add_hybrid_search_tsvector.sql
docker exec -it supabase-db psql -U postgres -d postgres -f /tmp/003_ollama_add_columns.sql
docker exec -it supabase-db psql -U postgres -d postgres -f /tmp/004_ollama_migrate_data.sql
docker exec -it supabase-db psql -U postgres -d postgres -f /tmp/005_ollama_create_functions.sql
docker exec -it supabase-db psql -U postgres -d postgres -f /tmp/006_ollama_create_indexes_optional.sql
docker exec -it supabase-db psql -U postgres -d postgres -f /tmp/007_add_priority_column_to_tasks.sql
docker exec -it supabase-db psql -U postgres -d postgres -f /tmp/008_add_migration_tracking.sql
docker exec -it supabase-db psql -U postgres -d postgres -f /tmp/009_add_cascade_delete_constraints.sql
docker exec -it supabase-db psql -U postgres -d postgres -f /tmp/010_add_provider_placeholders.sql
docker exec -it supabase-db psql -U postgres -d postgres -f /tmp/011_add_page_metadata_table.sql
docker exec -it supabase-db psql -U postgres -d postgres -f /tmp/012_add_context_hub_tables.sql
```

## Migration Safety

- ✅ **Safe to run multiple times** - Uses `IF NOT EXISTS` checks
- ✅ **Non-destructive** - Preserves all existing data
- ✅ **Automatic rollback** - Uses database transactions
- ✅ **Comprehensive logging** - Detailed progress notifications

## After Migration

1. **Restart Archon Services:**
   ```bash
   docker-compose restart
   ```

2. **Verify Migration:**
   - Check the Archon logs for any errors
   - Try running a test crawl
   - Verify search functionality works

3. **Configure New Features:**
   - Go to Settings page in Archon UI
   - Configure your preferred LLM and embedding models
   - Enable Context Hub feature toggle (if running migration 012)
   - Navigate to /context-hub to create templates
