-- ======================================================================
-- Migration 004: Ollama Implementation - Migrate Data
-- Migrates existing embeddings to new multi-dimensional columns
-- ======================================================================

BEGIN;

-- Migrate existing embedding data from old column (if exists)
DO $$
DECLARE
    crawled_pages_count INTEGER;
    code_examples_count INTEGER;
    dimension_detected INTEGER;
BEGIN
    -- Check if old embedding column exists
    SELECT COUNT(*) INTO crawled_pages_count
    FROM information_schema.columns
    WHERE table_name = 'archon_crawled_pages'
    AND column_name = 'embedding';

    IF crawled_pages_count > 0 THEN
        -- Detect dimension
        SELECT vector_dims(embedding) INTO dimension_detected
        FROM archon_crawled_pages
        WHERE embedding IS NOT NULL
        LIMIT 1;

        IF dimension_detected = 1536 THEN
            UPDATE archon_crawled_pages
            SET embedding_1536 = embedding,
                embedding_dimension = 1536,
                embedding_model = COALESCE(embedding_model, 'text-embedding-3-small')
            WHERE embedding IS NOT NULL AND embedding_1536 IS NULL;
        END IF;

        -- Drop old column
        ALTER TABLE archon_crawled_pages DROP COLUMN IF EXISTS embedding;
    END IF;

    -- Same for code_examples
    SELECT COUNT(*) INTO code_examples_count
    FROM information_schema.columns
    WHERE table_name = 'archon_code_examples'
    AND column_name = 'embedding';

    IF code_examples_count > 0 THEN
        SELECT vector_dims(embedding) INTO dimension_detected
        FROM archon_code_examples
        WHERE embedding IS NOT NULL
        LIMIT 1;

        IF dimension_detected = 1536 THEN
            UPDATE archon_code_examples
            SET embedding_1536 = embedding,
                embedding_dimension = 1536,
                embedding_model = COALESCE(embedding_model, 'text-embedding-3-small')
            WHERE embedding IS NOT NULL AND embedding_1536 IS NULL;
        END IF;

        ALTER TABLE archon_code_examples DROP COLUMN IF EXISTS embedding;
    END IF;
END $$;

-- Drop old indexes if they exist
DROP INDEX IF EXISTS idx_archon_crawled_pages_embedding;
DROP INDEX IF EXISTS idx_archon_code_examples_embedding;

COMMIT;

SELECT 'Ollama data migrated successfully' AS status;