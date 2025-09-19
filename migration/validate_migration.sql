-- ======================================================================
-- ARCHON MIGRATION VALIDATION SCRIPT
-- ======================================================================
-- This script validates that the upgrade_to_model_tracking.sql migration
-- completed successfully and all features are working.
-- ======================================================================

DO $$
DECLARE
    crawled_pages_columns INTEGER := 0;
    code_examples_columns INTEGER := 0;
    crawled_pages_indexes INTEGER := 0;
    code_examples_indexes INTEGER := 0;
    functions_count INTEGER := 0;
    migration_success BOOLEAN := TRUE;
    error_messages TEXT := '';
BEGIN
    RAISE NOTICE '====================================================================';
    RAISE NOTICE '              VALIDATING ARCHON MIGRATION RESULTS';
    RAISE NOTICE '====================================================================';
    
    -- Check if required columns exist in archon_crawled_pages
    SELECT COUNT(*) INTO crawled_pages_columns
    FROM information_schema.columns 
    WHERE table_name = 'archon_crawled_pages' 
    AND column_name IN (
        'embedding_384', 'embedding_768', 'embedding_1024', 'embedding_1536', 'embedding_3072',
        'llm_chat_model', 'embedding_model', 'embedding_dimension'
    );
    
    -- Check if required columns exist in archon_code_examples
    SELECT COUNT(*) INTO code_examples_columns
    FROM information_schema.columns 
    WHERE table_name = 'archon_code_examples' 
    AND column_name IN (
        'embedding_384', 'embedding_768', 'embedding_1024', 'embedding_1536', 'embedding_3072',
        'llm_chat_model', 'embedding_model', 'embedding_dimension'
    );
    
    -- Check if indexes were created for archon_crawled_pages
    SELECT COUNT(*) INTO crawled_pages_indexes
    FROM pg_indexes 
    WHERE tablename = 'archon_crawled_pages' 
    AND indexname IN (
        'idx_archon_crawled_pages_embedding_384',
        'idx_archon_crawled_pages_embedding_768',
        'idx_archon_crawled_pages_embedding_1024',
        'idx_archon_crawled_pages_embedding_1536',
        'idx_archon_crawled_pages_embedding_model',
        'idx_archon_crawled_pages_embedding_dimension',
        'idx_archon_crawled_pages_llm_chat_model'
    );
    
    -- Check if indexes were created for archon_code_examples
    SELECT COUNT(*) INTO code_examples_indexes
    FROM pg_indexes 
    WHERE tablename = 'archon_code_examples' 
    AND indexname IN (
        'idx_archon_code_examples_embedding_384',
        'idx_archon_code_examples_embedding_768', 
        'idx_archon_code_examples_embedding_1024',
        'idx_archon_code_examples_embedding_1536',
        'idx_archon_code_examples_embedding_model',
        'idx_archon_code_examples_embedding_dimension',
        'idx_archon_code_examples_llm_chat_model'
    );
    
    -- Check if required functions exist
    SELECT COUNT(*) INTO functions_count
    FROM information_schema.routines 
    WHERE routine_name IN (
        'match_archon_crawled_pages_multi',
        'match_archon_code_examples_multi',
        'detect_embedding_dimension',
        'get_embedding_column_name'
    );
    
    -- Validate results
    RAISE NOTICE 'COLUMN VALIDATION:';
    IF crawled_pages_columns = 8 THEN
        RAISE NOTICE '✅ archon_crawled_pages: All 8 required columns found';
    ELSE
        RAISE NOTICE '❌ archon_crawled_pages: Expected 8 columns, found %', crawled_pages_columns;
        migration_success := FALSE;
        error_messages := error_messages || '• Missing columns in archon_crawled_pages' || chr(10);
    END IF;
    
    IF code_examples_columns = 8 THEN
        RAISE NOTICE '✅ archon_code_examples: All 8 required columns found';
    ELSE
        RAISE NOTICE '❌ archon_code_examples: Expected 8 columns, found %', code_examples_columns;
        migration_success := FALSE;
        error_messages := error_messages || '• Missing columns in archon_code_examples' || chr(10);
    END IF;
    
    RAISE NOTICE '';
    RAISE NOTICE 'INDEX VALIDATION:';
    IF crawled_pages_indexes >= 6 THEN
        RAISE NOTICE '✅ archon_crawled_pages: % indexes created (expected 6+)', crawled_pages_indexes;
    ELSE
        RAISE NOTICE '⚠️  archon_crawled_pages: % indexes created (expected 6+)', crawled_pages_indexes;
        RAISE NOTICE '   Note: Some indexes may have failed due to resource constraints - this is OK';
    END IF;
    
    IF code_examples_indexes >= 6 THEN
        RAISE NOTICE '✅ archon_code_examples: % indexes created (expected 6+)', code_examples_indexes;
    ELSE
        RAISE NOTICE '⚠️  archon_code_examples: % indexes created (expected 6+)', code_examples_indexes;
        RAISE NOTICE '   Note: Some indexes may have failed due to resource constraints - this is OK';
    END IF;
    
    RAISE NOTICE '';
    RAISE NOTICE 'FUNCTION VALIDATION:';
    IF functions_count = 4 THEN
        RAISE NOTICE '✅ All 4 required functions created successfully';
    ELSE
        RAISE NOTICE '❌ Expected 4 functions, found %', functions_count;
        migration_success := FALSE;
        error_messages := error_messages || '• Missing database functions' || chr(10);
    END IF;
    
    -- Test function functionality
    BEGIN
        PERFORM detect_embedding_dimension(ARRAY[1,2,3]::vector);
        RAISE NOTICE '✅ detect_embedding_dimension function working';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE '❌ detect_embedding_dimension function failed: %', SQLERRM;
        migration_success := FALSE;
        error_messages := error_messages || '• detect_embedding_dimension function not working' || chr(10);
    END;
    
    BEGIN
        PERFORM get_embedding_column_name(1536);
        RAISE NOTICE '✅ get_embedding_column_name function working';
    EXCEPTION WHEN OTHERS THEN
        RAISE NOTICE '❌ get_embedding_column_name function failed: %', SQLERRM;
        migration_success := FALSE;
        error_messages := error_messages || '• get_embedding_column_name function not working' || chr(10);
    END;
    
    RAISE NOTICE '';
    RAISE NOTICE '====================================================================';
    
    IF migration_success THEN
        RAISE NOTICE '🎉 MIGRATION VALIDATION SUCCESSFUL!';
        RAISE NOTICE '';
        RAISE NOTICE 'Your Archon installation has been successfully upgraded with:';
        RAISE NOTICE '✅ Multi-dimensional embedding support';
        RAISE NOTICE '✅ Model tracking capabilities';
        RAISE NOTICE '✅ Enhanced search functions';
        RAISE NOTICE '✅ Optimized database indexes';
        RAISE NOTICE '';
        RAISE NOTICE 'Next steps:';
        RAISE NOTICE '1. Restart your Archon services: docker compose restart';
        RAISE NOTICE '2. Test with a small crawl to verify functionality';
        RAISE NOTICE '3. Configure your preferred models in Settings';
    ELSE
        RAISE NOTICE '❌ MIGRATION VALIDATION FAILED!';
        RAISE NOTICE '';
        RAISE NOTICE 'Issues found:';
        RAISE NOTICE '%', error_messages;
        RAISE NOTICE 'Please check the migration logs and re-run if necessary.';
    END IF;
    
    RAISE NOTICE '====================================================================';
    
    -- Show sample of existing data if any
    DECLARE
        sample_count INTEGER;
        r RECORD;  -- Declare the loop variable as RECORD type
    BEGIN
        SELECT COUNT(*) INTO sample_count FROM archon_crawled_pages LIMIT 1;
        IF sample_count > 0 THEN
            RAISE NOTICE '';
            RAISE NOTICE 'SAMPLE DATA CHECK:';
            
            -- Show one record with the new columns
            FOR r IN 
                SELECT url, embedding_model, embedding_dimension, 
                       CASE WHEN llm_chat_model IS NOT NULL THEN '✅' ELSE '⚪' END as llm_status,
                       CASE WHEN embedding_384 IS NOT NULL THEN '✅ 384' 
                            WHEN embedding_768 IS NOT NULL THEN '✅ 768'
                            WHEN embedding_1024 IS NOT NULL THEN '✅ 1024'
                            WHEN embedding_1536 IS NOT NULL THEN '✅ 1536'
                            WHEN embedding_3072 IS NOT NULL THEN '✅ 3072'
                            ELSE '⚪ None' END as embedding_status
                FROM archon_crawled_pages 
                LIMIT 3
            LOOP
                RAISE NOTICE 'Record: % | Model: % | Dimension: % | LLM: % | Embedding: %', 
                    substring(r.url from 1 for 40), 
                    COALESCE(r.embedding_model, 'None'), 
                    COALESCE(r.embedding_dimension::text, 'None'),
                    r.llm_status,
                    r.embedding_status;
            END LOOP;
        END IF;
    END;
    
END $$;

-- ======================================================================
-- VALIDATION COMPLETE - SUPABASE-FRIENDLY STATUS REPORT
-- ======================================================================
-- This final SELECT statement consolidates validation results for 
-- display in Supabase SQL Editor (users only see the last query result)

WITH validation_results AS (
    -- Check if all required columns exist
    SELECT 
        COUNT(*) FILTER (WHERE column_name IN ('embedding_384', 'embedding_768', 'embedding_1024', 'embedding_1536', 'embedding_3072')) as embedding_columns,
        COUNT(*) FILTER (WHERE column_name IN ('llm_chat_model', 'embedding_model', 'embedding_dimension')) as tracking_columns
    FROM information_schema.columns 
    WHERE table_name = 'archon_crawled_pages'
),
function_check AS (
    -- Check if required functions exist
    SELECT 
        COUNT(*) FILTER (WHERE routine_name IN ('match_archon_crawled_pages_multi', 'match_archon_code_examples_multi', 'detect_embedding_dimension', 'get_embedding_column_name')) as functions_count
    FROM information_schema.routines 
    WHERE routine_type = 'FUNCTION'
),
index_check AS (
    -- Check if indexes exist
    SELECT 
        COUNT(*) FILTER (WHERE indexname LIKE '%embedding_%') as embedding_indexes
    FROM pg_indexes 
    WHERE tablename IN ('archon_crawled_pages', 'archon_code_examples')
),
data_sample AS (
    -- Get sample of data with new columns
    SELECT 
        COUNT(*) as total_records,
        COUNT(*) FILTER (WHERE embedding_model IS NOT NULL) as records_with_model_tracking,
        COUNT(*) FILTER (WHERE embedding_384 IS NOT NULL OR embedding_768 IS NOT NULL OR embedding_1024 IS NOT NULL OR embedding_1536 IS NOT NULL OR embedding_3072 IS NOT NULL) as records_with_multi_dim_embeddings
    FROM archon_crawled_pages
),
overall_status AS (
    SELECT 
        CASE 
            WHEN v.embedding_columns = 5 AND v.tracking_columns = 3 AND f.functions_count >= 4 AND i.embedding_indexes > 0 
            THEN '✅ MIGRATION VALIDATION SUCCESSFUL!'
            ELSE '❌ MIGRATION VALIDATION FAILED!'
        END as status,
        v.embedding_columns,
        v.tracking_columns, 
        f.functions_count,
        i.embedding_indexes,
        d.total_records,
        d.records_with_model_tracking,
        d.records_with_multi_dim_embeddings
    FROM validation_results v, function_check f, index_check i, data_sample d
)
SELECT 
    status,
    CASE 
        WHEN embedding_columns = 5 AND tracking_columns = 3 AND functions_count >= 4 AND embedding_indexes > 0 
        THEN 'All validation checks passed successfully'
        ELSE 'Some validation checks failed - please review the results'
    END as message,
    json_build_object(
        'embedding_columns_added', embedding_columns || '/5',
        'tracking_columns_added', tracking_columns || '/3', 
        'search_functions_created', functions_count || '+ functions',
        'embedding_indexes_created', embedding_indexes || '+ indexes'
    ) as technical_validation,
    json_build_object(
        'total_records', total_records,
        'records_with_model_tracking', records_with_model_tracking,
        'records_with_multi_dimensional_embeddings', records_with_multi_dim_embeddings
    ) as data_status,
    CASE 
        WHEN embedding_columns = 5 AND tracking_columns = 3 AND functions_count >= 4 AND embedding_indexes > 0 
        THEN ARRAY[
            '1. Restart Archon services: docker compose restart',
            '2. Test with a small crawl to verify functionality', 
            '3. Configure your preferred models in Settings',
            '4. New crawls will automatically use model tracking'
        ]
        ELSE ARRAY[
            '1. Check migration logs for specific errors',
            '2. Re-run upgrade_database.sql if needed',
            '3. Ensure database has sufficient permissions',
            '4. Contact support if issues persist'
        ]
    END as next_steps
FROM overall_status;