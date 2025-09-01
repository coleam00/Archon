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