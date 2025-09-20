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

**2.1. `001_add_source_url_display_name.sql`**
- Adds display name field to sources table
- Improves UI presentation of crawled sources

**2.2. `002_add_hybrid_search_tsvector.sql`**
- Adds full-text search capabilities
- Implements hybrid search with tsvector columns
- Creates optimized search indexes

**2.3. `003_ollama_implementation.sql`**
- Multi-dimensional embedding support (384, 768, 1024, 1536, 3072 dimensions)
- Model tracking fields (`llm_chat_model`, `embedding_model`, `embedding_dimension`)
- Optimized indexes for improved search performance
- Enhanced search functions with dimension-aware querying
- Automatic migration of existing embedding data

**2.4. `004_add_priority_column_to_tasks.sql`**
- Adds priority field to tasks table
- Enables task prioritization in project management

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
-- 3. Run: 003_ollama_implementation.sql
-- 4. Run: 004_add_priority_column_to_tasks.sql
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
\i /path/to/003_ollama_implementation.sql
\i /path/to/004_add_priority_column_to_tasks.sql

# Exit
\q
```

### Method 3: Using Docker (if using local Supabase)
```bash
# Copy migrations to container
docker cp 001_add_source_url_display_name.sql supabase-db:/tmp/
docker cp 002_add_hybrid_search_tsvector.sql supabase-db:/tmp/
docker cp 003_ollama_implementation.sql supabase-db:/tmp/
docker cp 004_add_priority_column_to_tasks.sql supabase-db:/tmp/

# Execute migrations in order
docker exec -it supabase-db psql -U postgres -d postgres -f /tmp/001_add_source_url_display_name.sql
docker exec -it supabase-db psql -U postgres -d postgres -f /tmp/002_add_hybrid_search_tsvector.sql
docker exec -it supabase-db psql -U postgres -d postgres -f /tmp/003_ollama_implementation.sql
docker exec -it supabase-db psql -U postgres -d postgres -f /tmp/004_add_priority_column_to_tasks.sql
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
   - New crawls will automatically use model tracking
