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

-- Add priority column to archon_tasks table (safe, idempotent)
DO $$ BEGIN
    ALTER TABLE archon_tasks ADD COLUMN priority task_priority DEFAULT 'medium';
EXCEPTION
    WHEN duplicate_column THEN 
        RAISE NOTICE 'priority column already exists, skipping addition';
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

-- Backfill existing data based on current task_order values (safe, conditional)
-- Only update tasks that still have the default 'medium' priority to avoid overwriting user changes
-- Map task_order ranges to priority levels:
-- 1-25: critical (highest priority)
-- 26-50: high 
-- 51-75: medium
-- 76+: low (lowest priority)
DO $$ 
DECLARE 
    updated_count INTEGER;
BEGIN
    -- Only proceed if priority column exists
    IF EXISTS (SELECT 1 FROM information_schema.columns 
               WHERE table_name = 'archon_tasks' AND column_name = 'priority') THEN
        
        -- Update only tasks with default priority that haven't been modified by users
        UPDATE archon_tasks 
        SET priority = 
          CASE 
            WHEN task_order <= 25 THEN 'critical'::task_priority
            WHEN task_order <= 50 THEN 'high'::task_priority  
            WHEN task_order <= 75 THEN 'medium'::task_priority
            ELSE 'low'::task_priority
          END
        WHERE priority = 'medium'  -- Only update defaults
          AND task_order IS NOT NULL  -- Ensure task_order exists
          AND updated_at = created_at;  -- Only update tasks never modified (fresh records)
        
        GET DIAGNOSTICS updated_count = ROW_COUNT;
        RAISE NOTICE 'Backfilled % tasks with priority based on task_order', updated_count;
    ELSE
        RAISE NOTICE 'priority column does not exist, skipping backfill';
    END IF;
END $$;

-- Note: After this migration, task_order will be used solely for
-- visual positioning in drag-and-drop operations, while priority
-- will be used for semantic importance and filtering
--
-- This migration is safe to run multiple times and will not conflict
-- with complete_setup.sql for fresh installations.