# Archon Database Migrations

This folder contains database migration scripts for upgrading existing Archon installations.

## Available Migration Scripts

### 1. `backup_before_migration.sql` - Pre-Migration Backup
**Always run this FIRST before any migration!**

Creates timestamped backup tables of all your existing data:
- ✅ Complete backup of `archon_crawled_pages`
- ✅ Complete backup of `archon_code_examples` 
- ✅ Complete backup of `archon_sources`
- ✅ Easy restore commands provided
- ✅ Row count verification

### 2. `upgrade_to_model_tracking.sql` - Main Migration Script
**Use this migration if you:**
- Have an existing Archon installation from before multi-dimensional embedding support
- Want to upgrade to the latest features including model tracking
- Need to migrate existing embedding data to the new schema

**Features added:**
- ✅ Multi-dimensional embedding support (384, 768, 1024, 1536, 3072 dimensions)
- ✅ Model tracking fields (`llm_chat_model`, `embedding_model`, `embedding_dimension`)
- ✅ Optimized indexes for improved search performance
- ✅ Enhanced search functions with dimension-aware querying
- ✅ Automatic migration of existing embedding data
- ✅ Legacy compatibility maintained

### 3. `validate_migration.sql` - Post-Migration Validation
**Run this after the migration to verify everything worked correctly**

Validates your migration results:
- ✅ Verifies all required columns were added
- ✅ Checks that database indexes were created
- ✅ Tests that all functions are working
- ✅ Shows sample data with new fields
- ✅ Provides clear success/failure reporting

## Migration Process (Follow This Order!)

### Step 1: Backup Your Data
```sql
-- Run: backup_before_migration.sql
-- This creates timestamped backup tables of all your data
```

### Step 2: Run the Main Migration
```sql  
-- Run: upgrade_to_model_tracking.sql
-- This adds all the new features and migrates existing data
```

### Step 3: Validate the Results
```sql
-- Run: validate_migration.sql  
-- This verifies everything worked correctly
```

### Step 4: Restart Services
```bash
docker compose restart
```

## How to Run Migrations

### Method 1: Using Supabase Dashboard (Recommended)
1. Open your Supabase project dashboard
2. Go to **SQL Editor**
3. Copy and paste the contents of the migration file
4. Click **Run** to execute the migration
5. Check the output for success notifications

### Method 2: Using psql Command Line
```bash
# Connect to your database
psql -h your-supabase-host -p 5432 -U postgres -d postgres

# Run the migration
\i /path/to/upgrade_to_model_tracking.sql

# Exit
\q
```

### Method 3: Using Docker (if using local Supabase)
```bash
# Copy migration to container
docker cp upgrade_to_model_tracking.sql supabase-db:/tmp/

# Execute migration
docker exec -it supabase-db psql -U postgres -d postgres -f /tmp/upgrade_to_model_tracking.sql
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

## Troubleshooting

### Permission Errors
If you get permission errors, ensure your database user has sufficient privileges:
```sql
GRANT ALL PRIVILEGES ON DATABASE postgres TO your_user;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO your_user;
```

### Index Creation Failures
If index creation fails due to resource constraints, the migration will continue. You can create indexes manually later:
```sql
-- Example: Create missing index for 768-dimensional embeddings
CREATE INDEX idx_archon_crawled_pages_embedding_768 
ON archon_crawled_pages USING ivfflat (embedding_768 vector_cosine_ops) 
WITH (lists = 100);
```

### Migration Verification
Check that the migration completed successfully:
```sql
-- Verify new columns exist
SELECT column_name 
FROM information_schema.columns 
WHERE table_name = 'archon_crawled_pages' 
AND column_name IN ('llm_chat_model', 'embedding_model', 'embedding_dimension', 'embedding_384', 'embedding_768');

-- Verify functions exist
SELECT routine_name 
FROM information_schema.routines 
WHERE routine_name IN ('match_archon_crawled_pages_multi', 'detect_embedding_dimension');
```

## Support

If you encounter issues with the migration:

1. Check the console output for detailed error messages
2. Verify your database connection and permissions
3. Ensure you have sufficient disk space for index creation
4. Create a GitHub issue with the error details if problems persist

## Version Compatibility

- **Archon v2.0+**: Use `upgrade_to_model_tracking.sql`
- **Earlier versions**: Use `complete_setup.sql` for fresh installations

This migration is designed to bring any Archon installation up to the latest schema standards while preserving all existing data and functionality.