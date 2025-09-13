-- =====================================================
-- Add priority column to archon_tasks table
-- =====================================================
-- This migration adds a dedicated priority column to decouple
-- task priority from task_order field:
-- - priority: Enum field for semantic importance (low, medium, high, critical)
-- - task_order: Remains for visual drag-and-drop positioning only
--
-- This solves the coupling issue where changing task position
-- accidentally changed task priority, enabling independent
-- priority management and visual task organization.
--
-- SAFE & IDEMPOTENT: Can be run multiple times without issues
-- Compatible with complete_setup.sql for fresh installations
-- =====================================================

-- Create enum type for task priority (safe, idempotent)
DO $$ BEGIN
    CREATE TYPE task_priority AS ENUM ('low', 'medium', 'high', 'critical');
EXCEPTION
    WHEN duplicate_object THEN 
        -- Type already exists, check if it has the right values
        RAISE NOTICE 'task_priority enum already exists, skipping creation';
END $$;

-- Add priority column to archon_tasks table (safe, idempotent with NOT NULL constraint)
DO $$ BEGIN
    -- Add column as nullable first with default
    ALTER TABLE archon_tasks ADD COLUMN priority task_priority DEFAULT 'medium';
    
    -- Ensure all existing rows have the default value (handles any NULLs)
    UPDATE archon_tasks SET priority = 'medium' WHERE priority IS NULL;
    
    -- Make column NOT NULL to enforce application invariants
    ALTER TABLE archon_tasks ALTER COLUMN priority SET NOT NULL;
    
    RAISE NOTICE 'Added priority column with NOT NULL constraint and default value';
EXCEPTION
    WHEN duplicate_column THEN 
        -- Column exists, ensure it's NOT NULL and has proper default
        BEGIN
            -- Ensure no NULL values exist
            UPDATE archon_tasks SET priority = 'medium' WHERE priority IS NULL;
            
            -- Ensure NOT NULL constraint (safe if already NOT NULL)
            BEGIN
                ALTER TABLE archon_tasks ALTER COLUMN priority SET NOT NULL;
            EXCEPTION
                WHEN OTHERS THEN
                    RAISE NOTICE 'priority column already has NOT NULL constraint';
            END;
            
            -- Ensure default value is set (safe if already set)
            BEGIN
                ALTER TABLE archon_tasks ALTER COLUMN priority SET DEFAULT 'medium';
            EXCEPTION
                WHEN OTHERS THEN
                    RAISE NOTICE 'priority column already has default value';
            END;
            
        END;
        RAISE NOTICE 'priority column already exists, ensured NOT NULL constraint and default';
END $$;

-- Add index for the priority column for better query performance (safe, idempotent)
CREATE INDEX IF NOT EXISTS idx_archon_tasks_priority ON archon_tasks(priority);

-- Add comment to document the new column (safe, idempotent)
DO $$ BEGIN
    COMMENT ON COLUMN archon_tasks.priority IS 'Task priority level independent of visual ordering - used for semantic importance (low, medium, high, critical)';
EXCEPTION
    WHEN undefined_column THEN 
        RAISE NOTICE 'priority column does not exist yet, skipping comment';
END $$;

-- Set all existing tasks to default priority (clean slate approach)
-- This truly decouples priority from task_order - no relationship at all
DO $$ 
DECLARE 
    updated_count INTEGER;
BEGIN
    -- Only proceed if priority column exists
    IF EXISTS (SELECT 1 FROM information_schema.columns 
               WHERE table_name = 'archon_tasks' AND column_name = 'priority') THEN
        
        -- Set all existing tasks to medium priority (clean slate)
        -- Users can explicitly set priorities as needed after migration
        UPDATE archon_tasks 
        SET priority = 'medium'::task_priority
        WHERE priority IS NULL;  -- Only update NULL values, preserve any existing priorities
        
        GET DIAGNOSTICS updated_count = ROW_COUNT;
        RAISE NOTICE 'Set % existing tasks to medium priority (clean slate)', updated_count;
    ELSE
        RAISE NOTICE 'priority column does not exist, skipping initialization';
    END IF;
END $$;

-- Note: After this migration, task_order and priority are completely independent:
-- - task_order: Visual positioning in drag-and-drop operations only
-- - priority: Semantic importance (critical, high, medium, low) only
-- 
-- Clean slate approach: All existing tasks start with 'medium' priority
-- Users can explicitly set priorities as needed - no backward compatibility
--
-- This migration is safe to run multiple times and will not conflict
-- with complete_setup.sql for fresh installations.