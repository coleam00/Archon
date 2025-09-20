-- ======================================================================
-- ARCHON DATABASE RESET SCRIPT
-- ======================================================================
-- 
-- This script safely resets the entire Archon database by dropping all
-- tables, types, functions, triggers, and policies with conditional checks
-- and cascading drops to maintain referential integrity.
--
-- ⚠️  WARNING: THIS WILL DELETE ALL DATA! ⚠️
-- 
-- Usage:
--   1. Connect to your Supabase/PostgreSQL database
--   2. Run this script in the SQL editor
--   3. Run migration/complete_setup.sql to recreate the schema
--
-- Created: 2024-01-01
-- Updated: 2025-01-07 - Added archon_ prefix to all tables
-- ======================================================================

BEGIN;

-- Disable foreign key checks temporarily for clean drops
SET session_replication_role = replica;

-- ======================================================================
-- 1. DROP ROW LEVEL SECURITY POLICIES
-- ======================================================================

DO $$ 
BEGIN
    -- Drop all RLS policies on all tables
    RAISE NOTICE 'Dropping Row Level Security policies...';
    
    -- Settings table policies
    DROP POLICY IF EXISTS "Allow service role full access" ON archon_settings;
    DROP POLICY IF EXISTS "Allow authenticated users to read and update" ON archon_settings;
    
    -- Crawled pages policies
    DROP POLICY IF EXISTS "Allow public read access to archon_crawled_pages" ON archon_crawled_pages;
    
    -- Sources policies  
    DROP POLICY IF EXISTS "Allow public read access to archon_sources" ON archon_sources;
    
    -- Code examples policies
    DROP POLICY IF EXISTS "Allow public read access to archon_code_examples" ON archon_code_examples;
    
    -- Projects policies
    DROP POLICY IF EXISTS "Allow service role full access to archon_projects" ON archon_projects;
    DROP POLICY IF EXISTS "Allow authenticated users to read and update archon_projects" ON archon_projects;
    
    -- Tasks policies
    DROP POLICY IF EXISTS "Allow service role full access to archon_tasks" ON archon_tasks;
    DROP POLICY IF EXISTS "Allow authenticated users to read and update archon_tasks" ON archon_tasks;
    
    -- Project sources policies
    DROP POLICY IF EXISTS "Allow service role full access to archon_project_sources" ON archon_project_sources;
    DROP POLICY IF EXISTS "Allow authenticated users to read and update archon_project_sources" ON archon_project_sources;
    
    -- Document versions policies
    DROP POLICY IF EXISTS "Allow service role full access to archon_document_versions" ON archon_document_versions;
    DROP POLICY IF EXISTS "Allow authenticated users to read archon_document_versions" ON archon_document_versions;
    
    -- Prompts policies
    DROP POLICY IF EXISTS "Allow service role full access to archon_prompts" ON archon_prompts;
    DROP POLICY IF EXISTS "Allow authenticated users to read archon_prompts" ON archon_prompts;

    -- Migration tracking policies
    DROP POLICY IF EXISTS "Allow service role full access to archon_migrations" ON archon_migrations;
    DROP POLICY IF EXISTS "Allow authenticated users to read archon_migrations" ON archon_migrations;

    -- Legacy table policies (for migration from old schema)
    DROP POLICY IF EXISTS "Allow service role full access" ON settings;
    DROP POLICY IF EXISTS "Allow authenticated users to read and update" ON settings;
    DROP POLICY IF EXISTS "Allow public read access to crawled_pages" ON crawled_pages;
    DROP POLICY IF EXISTS "Allow public read access to sources" ON sources;
    DROP POLICY IF EXISTS "Allow public read access to code_examples" ON code_examples;
    DROP POLICY IF EXISTS "Allow service role full access to projects" ON projects;
    DROP POLICY IF EXISTS "Allow authenticated users to read and update projects" ON projects;
    DROP POLICY IF EXISTS "Allow service role full access to tasks" ON tasks;
    DROP POLICY IF EXISTS "Allow authenticated users to read and update tasks" ON tasks;
    DROP POLICY IF EXISTS "Allow service role full access to project_sources" ON project_sources;
    DROP POLICY IF EXISTS "Allow authenticated users to read and update project_sources" ON project_sources;
    DROP POLICY IF EXISTS "Allow service role full access to document_versions" ON document_versions;
    DROP POLICY IF EXISTS "Allow authenticated users to read and update document_versions" ON document_versions;
    DROP POLICY IF EXISTS "Allow authenticated users to read document_versions" ON document_versions;
    DROP POLICY IF EXISTS "Allow service role full access to prompts" ON prompts;
    DROP POLICY IF EXISTS "Allow authenticated users to read prompts" ON prompts;
    
    RAISE NOTICE 'RLS policies dropped successfully.';
    
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Some RLS policies may not exist: %', SQLERRM;
END $$;

-- ======================================================================
-- 2. DROP TRIGGERS
-- ======================================================================

DO $$
BEGIN
    RAISE NOTICE 'Dropping triggers...';
    
    -- Settings table triggers
    DROP TRIGGER IF EXISTS update_archon_settings_updated_at ON archon_settings;
    DROP TRIGGER IF EXISTS update_settings_updated_at ON settings;
    
    -- Projects table triggers
    DROP TRIGGER IF EXISTS update_archon_projects_updated_at ON archon_projects;
    DROP TRIGGER IF EXISTS update_projects_updated_at ON projects;
    
    -- Tasks table triggers
    DROP TRIGGER IF EXISTS update_archon_tasks_updated_at ON archon_tasks;
    DROP TRIGGER IF EXISTS update_tasks_updated_at ON tasks;
    
    -- Prompts table triggers
    DROP TRIGGER IF EXISTS update_archon_prompts_updated_at ON archon_prompts;
    DROP TRIGGER IF EXISTS update_prompts_updated_at ON prompts;
    
    RAISE NOTICE 'Triggers dropped successfully.';
    
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Some triggers may not exist: %', SQLERRM;
END $$;

-- ======================================================================
-- 3. DROP FUNCTIONS
-- ======================================================================

DO $$
BEGIN
    RAISE NOTICE 'Dropping functions...';
    
    -- Update timestamp function (used by triggers)
    DROP FUNCTION IF EXISTS update_updated_at_column() CASCADE;
    
    -- Search functions (new with archon_ prefix)
    DROP FUNCTION IF EXISTS match_archon_crawled_pages(vector, int, jsonb, text) CASCADE;
    DROP FUNCTION IF EXISTS match_archon_code_examples(vector, int, jsonb, text) CASCADE;
    
    -- Hybrid search functions (with ts_vector support)
    DROP FUNCTION IF EXISTS hybrid_search_archon_crawled_pages(vector, text, int, jsonb, text) CASCADE;
    DROP FUNCTION IF EXISTS hybrid_search_archon_code_examples(vector, text, int, jsonb, text) CASCADE;
    
    -- Search functions (old without prefix)
    DROP FUNCTION IF EXISTS match_crawled_pages(vector, int, jsonb, text) CASCADE;
    DROP FUNCTION IF EXISTS match_code_examples(vector, int, jsonb, text) CASCADE;
    
    -- Task management functions
    DROP FUNCTION IF EXISTS archive_task(UUID, TEXT) CASCADE;
    
    RAISE NOTICE 'Functions dropped successfully.';
    
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Some functions may not exist: %', SQLERRM;
END $$;

-- ======================================================================
-- 4. DROP TABLES (with CASCADE to handle dependencies)
-- ======================================================================

DO $$
BEGIN
    RAISE NOTICE 'Dropping tables with CASCADE...';
    
    -- Drop in reverse dependency order to minimize cascade issues
    
    -- Project System (complex dependencies) - new archon_ prefixed tables
    DROP TABLE IF EXISTS archon_document_versions CASCADE;
    DROP TABLE IF EXISTS archon_project_sources CASCADE;
    DROP TABLE IF EXISTS archon_tasks CASCADE;
    DROP TABLE IF EXISTS archon_projects CASCADE;
    DROP TABLE IF EXISTS archon_prompts CASCADE;
    
    -- Knowledge Base System - new archon_ prefixed tables
    DROP TABLE IF EXISTS archon_code_examples CASCADE;
    DROP TABLE IF EXISTS archon_crawled_pages CASCADE;
    DROP TABLE IF EXISTS archon_sources CASCADE;
    
    -- Configuration System - new archon_ prefixed table
    DROP TABLE IF EXISTS archon_settings CASCADE;

    -- Migration tracking table
    DROP TABLE IF EXISTS archon_migrations CASCADE;

    -- Legacy tables (without archon_ prefix) - for migration purposes
    DROP TABLE IF EXISTS document_versions CASCADE;
    DROP TABLE IF EXISTS project_sources CASCADE;
    DROP TABLE IF EXISTS tasks CASCADE;
    DROP TABLE IF EXISTS projects CASCADE;
    DROP TABLE IF EXISTS prompts CASCADE;
    DROP TABLE IF EXISTS code_examples CASCADE;
    DROP TABLE IF EXISTS crawled_pages CASCADE;
    DROP TABLE IF EXISTS sources CASCADE;
    DROP TABLE IF EXISTS settings CASCADE;
    
    RAISE NOTICE 'Tables dropped successfully.';
    
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Error dropping tables: %', SQLERRM;
END $$;

-- ======================================================================
-- 5. DROP CUSTOM TYPES/ENUMS
-- ======================================================================

DO $$
BEGIN
    RAISE NOTICE 'Dropping custom types and enums...';
    
    -- Task-related enums
    DROP TYPE IF EXISTS task_status CASCADE;
    DROP TYPE IF EXISTS task_assignee CASCADE;
    
    RAISE NOTICE 'Custom types dropped successfully.';
    
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Some custom types may not exist: %', SQLERRM;
END $$;

-- ======================================================================
-- 6. DROP INDEXES (if any remain)
-- ======================================================================

DO $$
DECLARE
    index_name TEXT;
BEGIN
    RAISE NOTICE 'Dropping remaining custom indexes...';
    
    -- Drop any remaining indexes that might not have been cascade-dropped
    FOR index_name IN 
        SELECT indexname 
        FROM pg_indexes 
        WHERE schemaname = 'public' 
        AND (indexname LIKE 'idx_%' OR indexname LIKE 'idx_archon_%')
    LOOP
        BEGIN
            EXECUTE 'DROP INDEX IF EXISTS ' || index_name || ' CASCADE';
        EXCEPTION WHEN OTHERS THEN
            -- Continue if index doesn't exist or can't be dropped
            NULL;
        END;
    END LOOP;
    
    RAISE NOTICE 'Custom indexes cleanup completed.';
    
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Index cleanup completed with warnings: %', SQLERRM;
END $$;

-- ======================================================================
-- 7. CLEANUP EXTENSIONS (conditional)
-- ======================================================================

DO $$
BEGIN
    RAISE NOTICE 'Checking extensions...';
    
    -- Note: We don't drop vector and pgcrypto extensions as they might be used
    -- by other applications. Only drop if you're sure they're not needed.
    
    -- Uncomment these lines if you want to remove extensions:
    -- DROP EXTENSION IF EXISTS vector CASCADE;
    -- DROP EXTENSION IF EXISTS pgcrypto CASCADE;
    
    RAISE NOTICE 'Extensions check completed (not dropped for safety).';
    
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'Extension cleanup had warnings: %', SQLERRM;
END $$;

-- Re-enable foreign key checks
SET session_replication_role = DEFAULT;

-- ======================================================================
-- 8. VERIFICATION AND SUMMARY
-- ======================================================================

DO $$
DECLARE
    table_count INTEGER;
    function_count INTEGER;
    type_count INTEGER;
BEGIN
    -- Count remaining custom objects
    SELECT COUNT(*) INTO table_count 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
    AND table_name NOT IN ('schema_migrations', 'supabase_migrations');
    
    SELECT COUNT(*) INTO function_count 
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
    AND p.proname NOT LIKE 'pg_%'
    AND p.proname NOT LIKE 'sql_%';
    
    SELECT COUNT(*) INTO type_count
    FROM pg_type t
    JOIN pg_namespace n ON t.typnamespace = n.oid
    WHERE n.nspname = 'public'
    AND t.typname NOT LIKE 'pg_%'
    AND t.typname NOT LIKE 'sql_%'
    AND t.typtype = 'e'; -- Only enums
    
    RAISE NOTICE '======================================================================';
    RAISE NOTICE '                     RESET COMPLETED SUCCESSFULLY';
    RAISE NOTICE '======================================================================';
    RAISE NOTICE 'Remaining objects in public schema:';
    RAISE NOTICE '  - Tables: %', table_count;
    RAISE NOTICE '  - Custom functions: %', function_count;
    RAISE NOTICE '  - Custom types/enums: %', type_count;
    RAISE NOTICE '';
    RAISE NOTICE 'Next steps:';
    RAISE NOTICE '  1. Run migration/complete_setup.sql';
    RAISE NOTICE '======================================================================';
    
END $$;

COMMIT;

-- ======================================================================
-- END OF RESET SCRIPT
-- ======================================================================