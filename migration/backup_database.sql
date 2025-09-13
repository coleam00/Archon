-- ======================================================================
-- ARCHON PRE-MIGRATION BACKUP SCRIPT
-- ======================================================================
-- This script creates backup tables of your existing data before running
-- the upgrade_to_model_tracking.sql migration.
-- 
-- IMPORTANT: Run this BEFORE running the main migration!
-- ======================================================================

BEGIN;

-- Create timestamp for backup tables
CREATE OR REPLACE FUNCTION get_backup_timestamp()
RETURNS TEXT AS $$
BEGIN
    RETURN to_char(now(), 'YYYYMMDD_HH24MISS');
END;
$$ LANGUAGE plpgsql;

-- Get the timestamp for consistent naming
DO $$
DECLARE
    backup_suffix TEXT;
BEGIN
    backup_suffix := get_backup_timestamp();
    
    -- Backup archon_crawled_pages
    EXECUTE format('CREATE TABLE archon_crawled_pages_backup_%s AS SELECT * FROM archon_crawled_pages', backup_suffix);
    
    -- Backup archon_code_examples
    EXECUTE format('CREATE TABLE archon_code_examples_backup_%s AS SELECT * FROM archon_code_examples', backup_suffix);
    
    -- Backup archon_sources
    EXECUTE format('CREATE TABLE archon_sources_backup_%s AS SELECT * FROM archon_sources', backup_suffix);
    
    RAISE NOTICE '====================================================================';
    RAISE NOTICE '                    BACKUP COMPLETED SUCCESSFULLY';
    RAISE NOTICE '====================================================================';
    RAISE NOTICE 'Created backup tables with suffix: %', backup_suffix;
    RAISE NOTICE '';
    RAISE NOTICE 'Backup tables created:';
    RAISE NOTICE '• archon_crawled_pages_backup_%', backup_suffix;
    RAISE NOTICE '• archon_code_examples_backup_%', backup_suffix;
    RAISE NOTICE '• archon_sources_backup_%', backup_suffix;
    RAISE NOTICE '';
    RAISE NOTICE 'You can now safely run the upgrade_to_model_tracking.sql migration.';
    RAISE NOTICE '';
    RAISE NOTICE 'To restore from backup if needed:';
    RAISE NOTICE 'DROP TABLE archon_crawled_pages;';
    RAISE NOTICE 'ALTER TABLE archon_crawled_pages_backup_% RENAME TO archon_crawled_pages;', backup_suffix;
    RAISE NOTICE '====================================================================';
    
    -- Get row counts for verification
    DECLARE
        crawled_count INTEGER;
        code_count INTEGER;
        sources_count INTEGER;
    BEGIN
        EXECUTE format('SELECT COUNT(*) FROM archon_crawled_pages_backup_%s', backup_suffix) INTO crawled_count;
        EXECUTE format('SELECT COUNT(*) FROM archon_code_examples_backup_%s', backup_suffix) INTO code_count;
        EXECUTE format('SELECT COUNT(*) FROM archon_sources_backup_%s', backup_suffix) INTO sources_count;
        
        RAISE NOTICE 'Backup verification:';
        RAISE NOTICE '• Crawled pages backed up: % records', crawled_count;
        RAISE NOTICE '• Code examples backed up: % records', code_count;
        RAISE NOTICE '• Sources backed up: % records', sources_count;
        RAISE NOTICE '====================================================================';
    END;
END $$;

-- Clean up the temporary function
DROP FUNCTION get_backup_timestamp();

COMMIT;

-- ======================================================================
-- BACKUP COMPLETE - SUPABASE-FRIENDLY STATUS REPORT
-- ======================================================================
-- This final SELECT statement shows backup status in Supabase SQL Editor

WITH backup_info AS (
    SELECT 
        to_char(now(), 'YYYYMMDD_HH24MISS') as backup_suffix,
        (SELECT COUNT(*) FROM archon_crawled_pages) as crawled_count,
        (SELECT COUNT(*) FROM archon_code_examples) as code_count,
        (SELECT COUNT(*) FROM archon_sources) as sources_count
)
SELECT 
    '🎉 ARCHON DATABASE BACKUP COMPLETED! 🎉' AS status,
    'Your data is now safely backed up' AS message,
    ARRAY[
        'archon_crawled_pages_backup_' || backup_suffix,
        'archon_code_examples_backup_' || backup_suffix,
        'archon_sources_backup_' || backup_suffix
    ] AS backup_tables_created,
    json_build_object(
        'crawled_pages', crawled_count,
        'code_examples', code_count,
        'sources', sources_count
    ) AS records_backed_up,
    ARRAY[
        '1. Run upgrade_database.sql to upgrade your installation',
        '2. Run validate_migration.sql to verify the upgrade',
        '3. Backup tables will be kept for safety'
    ] AS next_steps,
    'DROP TABLE archon_crawled_pages; ALTER TABLE archon_crawled_pages_backup_' || backup_suffix || ' RENAME TO archon_crawled_pages;' AS restore_command_example
FROM backup_info;