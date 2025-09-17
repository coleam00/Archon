# Archon Database Migration Guide

## Problem: Supabase SQL Editor Timeout

The full migration script times out in Supabase SQL editor due to memory-intensive vector index creation.

## Solution: Run Migration in Steps

### Method 1: Use Step-by-Step Scripts (Recommended)

Run these scripts in order in the Supabase SQL editor:

1. **Step 1**: `step1_add_columns.sql` - Adds new columns (fast, ~5 seconds)
2. **Step 2**: `step2_migrate_data.sql` - Migrates existing data (fast, ~10 seconds)
3. **Step 3**: `step3_create_functions.sql` - Creates search functions (fast, ~5 seconds)
4. **Step 4**: `step4_create_indexes_optional.sql` - Creates indexes (may timeout - OPTIONAL)

**Note**: If Step 4 times out, the system will still work using brute-force search. You can create indexes later.

### Method 2: Direct Database Connection

Connect directly to your Supabase database using psql or a database client:

#### Get Connection String
1. Go to Supabase Dashboard → Settings → Database
2. Copy the connection string (use "Session pooler" for migrations)
3. It looks like: `postgresql://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres`

#### Using psql
```bash
# Connect to database
psql "postgresql://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres"

# Run the full migration
\i migration/upgrade_database_with_memory_fix.sql

# Or run individual steps
\i migration/step1_add_columns.sql
\i migration/step2_migrate_data.sql
\i migration/step3_create_functions.sql
\i migration/step4_create_indexes_optional.sql
```

#### Using TablePlus/DBeaver/pgAdmin
1. Create new connection with your connection string
2. Open and run each SQL file in order
3. Monitor execution time and memory usage

### Method 3: Use Supabase CLI

```bash
# Install Supabase CLI
npm install -g supabase

# Login and link project
supabase login
supabase link --project-ref [your-project-ref]

# Run migration
supabase db push migration/upgrade_database_with_memory_fix.sql
```

### Method 4: Skip Vector Indexes Entirely

If you have a small dataset (<10,000 documents), you can skip Step 4 entirely. The system will use brute-force search which is fast enough for small datasets.

## Verification

After migration, run this query to verify:

```sql
SELECT
    EXISTS(SELECT 1 FROM information_schema.columns
           WHERE table_name = 'archon_crawled_pages'
           AND column_name = 'embedding_1536') as has_1536_column,
    EXISTS(SELECT 1 FROM information_schema.routines
           WHERE routine_name = 'match_archon_crawled_pages_multi') as has_multi_function,
    COUNT(*) as index_count
FROM pg_indexes
WHERE tablename IN ('archon_crawled_pages', 'archon_code_examples')
AND indexname LIKE '%embedding%';
```

Expected result:
- `has_1536_column`: true
- `has_multi_function`: true
- `index_count`: 8+ (or 0 if you skipped Step 4)

## Troubleshooting

### "Memory required" error
- Increase `maintenance_work_mem` in the script
- Use direct database connection instead of SQL editor
- Create indexes one at a time

### "Statement timeout" error
- Run scripts in smaller steps
- Use direct database connection
- Increase `statement_timeout` setting

### "Permission denied" error
- Ensure you're using the service role key
- Check database permissions in Supabase dashboard

## Post-Migration

After successful migration:

1. **Restart services**:
   ```bash
   docker compose restart
   ```

2. **Test the system**:
   - Check if RAG search works in the UI
   - Try crawling a new website
   - Verify embeddings are being created

3. **Monitor performance**:
   - If searches are slow without indexes, create them via direct connection
   - Consider using smaller embedding dimensions (384 or 768) for faster performance

## Need Help?

If you encounter issues:
1. Check Supabase logs: Dashboard → Logs → Postgres
2. Verify your Supabase plan has sufficient resources
3. Contact Supabase support for memory limit increases (paid plans only)