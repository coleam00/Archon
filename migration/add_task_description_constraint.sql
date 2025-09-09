-- =====================================================
-- Migration: Add CHECK constraint for task description length
-- Purpose: Enforce 50,000 character limit at database level
-- Date: 2025-01-09
-- =====================================================

-- Step 1: Check for existing descriptions that exceed the limit
-- This query identifies any tasks that would violate the new constraint
DO $$
DECLARE
    violation_count INTEGER;
    max_length INTEGER;
BEGIN
    -- Count violations
    SELECT COUNT(*), COALESCE(MAX(char_length(description)), 0)
    INTO violation_count, max_length
    FROM archon_tasks
    WHERE description IS NOT NULL 
    AND char_length(description) > 50000;
    
    IF violation_count > 0 THEN
        RAISE NOTICE 'WARNING: Found % task(s) with descriptions exceeding 50,000 characters', violation_count;
        RAISE NOTICE 'Maximum description length found: % characters', max_length;
        RAISE NOTICE 'These will be truncated to 50,000 characters before applying constraint';
        
        -- Truncate oversized descriptions (preserve first 49,997 chars + '...')
        UPDATE archon_tasks
        SET description = LEFT(description, 49997) || '...',
            updated_at = NOW()
        WHERE description IS NOT NULL 
        AND char_length(description) > 50000;
        
        RAISE NOTICE 'Truncated % task description(s)', violation_count;
    ELSE
        RAISE NOTICE 'No existing task descriptions exceed 50,000 characters';
    END IF;
END $$;

-- Step 2: Add the CHECK constraint
-- This prevents any future descriptions from exceeding 50,000 characters
ALTER TABLE archon_tasks
    ADD CONSTRAINT tasks_description_length_check
    CHECK (description IS NULL OR char_length(description) <= 50000);

-- Step 3: Add a comment documenting the constraint
COMMENT ON CONSTRAINT tasks_description_length_check ON archon_tasks 
    IS 'Enforces maximum description length of 50,000 characters to prevent performance issues';

-- Step 4: Verify the constraint was added successfully
DO $$
DECLARE
    constraint_exists BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'tasks_description_length_check'
        AND conrelid = 'archon_tasks'::regclass
    ) INTO constraint_exists;
    
    IF constraint_exists THEN
        RAISE NOTICE 'SUCCESS: Constraint tasks_description_length_check has been added to archon_tasks table';
    ELSE
        RAISE EXCEPTION 'ERROR: Failed to add constraint tasks_description_length_check';
    END IF;
END $$;

-- =====================================================
-- Rollback Script (if needed)
-- =====================================================
-- To remove this constraint, run:
-- ALTER TABLE archon_tasks DROP CONSTRAINT IF EXISTS tasks_description_length_check;