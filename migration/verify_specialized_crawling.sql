-- =====================================================
-- Specialized Crawling Migration Verification Script
-- =====================================================
-- Run this script AFTER applying add_specialized_crawling_tables.sql
-- to verify that all tables and data were created correctly
-- =====================================================

-- Check 1: Verify all new tables exist
SELECT 
    'Table Check' as verification_type,
    table_name,
    CASE 
        WHEN table_name IS NOT NULL THEN '✓ EXISTS'
        ELSE '✗ MISSING'
    END as status
FROM (
    SELECT 'archon_ecommerce_products' as expected_table
    UNION SELECT 'archon_crawling_modes'
    UNION SELECT 'archon_crawling_performance' 
    UNION SELECT 'archon_structured_data'
) expected
LEFT JOIN information_schema.tables t ON t.table_name = expected.expected_table
WHERE t.table_schema = 'public' OR t.table_name IS NULL
ORDER BY expected_table;

-- Check 2: Verify crawling modes were inserted
SELECT 
    'Mode Check' as verification_type,
    mode_name,
    enabled,
    CASE 
        WHEN enabled THEN '✓ ENABLED'
        ELSE '⚠ DISABLED'
    END as status,
    created_at
FROM archon_crawling_modes 
ORDER BY mode_name;

-- Check 3: Count records in each table
SELECT 
    'Record Count' as verification_type,
    'archon_ecommerce_products' as table_name,
    COUNT(*) as record_count
FROM archon_ecommerce_products
UNION ALL
SELECT 
    'Record Count',
    'archon_crawling_modes',
    COUNT(*)
FROM archon_crawling_modes
UNION ALL
SELECT 
    'Record Count',
    'archon_crawling_performance',
    COUNT(*)
FROM archon_crawling_performance
UNION ALL
SELECT 
    'Record Count',
    'archon_structured_data',
    COUNT(*)
FROM archon_structured_data;

-- Check 4: Verify archon_sources table enhancements (if table exists)
DO $$
BEGIN
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'archon_sources') THEN
        RAISE NOTICE 'Checking archon_sources enhancements...';
        
        -- Check for new columns
        PERFORM column_name FROM information_schema.columns 
        WHERE table_name = 'archon_sources' AND column_name = 'crawling_mode';
        
        IF FOUND THEN
            RAISE NOTICE '✓ archon_sources enhanced with crawling_mode column';
        ELSE
            RAISE NOTICE '✗ archon_sources missing crawling_mode column';
        END IF;
    ELSE
        RAISE NOTICE 'archon_sources table does not exist - enhancement skipped';
    END IF;
END
$$;

-- Check 5: Verify indexes exist
SELECT 
    'Index Check' as verification_type,
    indexname as index_name,
    tablename as table_name,
    '✓ EXISTS' as status
FROM pg_indexes 
WHERE schemaname = 'public' 
  AND (
    indexname LIKE 'idx_ecommerce_%' OR
    indexname LIKE 'idx_crawling_%' OR
    indexname LIKE 'idx_structured_%' OR
    indexname LIKE 'idx_sources_crawling_%'
  )
ORDER BY tablename, indexname;

-- Check 6: Test e-commerce mode configuration
SELECT 
    'Configuration Test' as verification_type,
    mode_name,
    (mode_config->>'extract_pricing')::boolean as extract_pricing,
    (mode_config->>'stealth_mode')::boolean as stealth_mode,
    array_length(url_patterns::jsonb, 1) as pattern_count
FROM archon_crawling_modes 
WHERE mode_name = 'ecommerce';

-- Check 7: Verify RLS policies exist
SELECT 
    'RLS Policy Check' as verification_type,
    tablename,
    policyname,
    '✓ EXISTS' as status
FROM pg_policies 
WHERE schemaname = 'public' 
  AND tablename IN (
    'archon_ecommerce_products',
    'archon_crawling_modes', 
    'archon_crawling_performance',
    'archon_structured_data'
  )
ORDER BY tablename, policyname;

-- Final Summary
SELECT 
    'MIGRATION SUMMARY' as summary,
    COUNT(DISTINCT t.table_name) as tables_created,
    (SELECT COUNT(*) FROM archon_crawling_modes) as modes_configured,
    (SELECT COUNT(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE 'idx_%crawling%') as indexes_created
FROM information_schema.tables t
WHERE t.table_schema = 'public' 
  AND t.table_name IN (
    'archon_ecommerce_products',
    'archon_crawling_modes',
    'archon_crawling_performance', 
    'archon_structured_data'
  );

-- Success message
DO $$
BEGIN
    RAISE NOTICE '========================================';
    RAISE NOTICE 'MIGRATION VERIFICATION COMPLETE';
    RAISE NOTICE '========================================';
    RAISE NOTICE 'Check the query results above to verify:';
    RAISE NOTICE '1. All 4 tables were created';
    RAISE NOTICE '2. 4 crawling modes were configured';
    RAISE NOTICE '3. Indexes were created properly';
    RAISE NOTICE '4. RLS policies are in place';
    RAISE NOTICE '========================================';
END
$$;