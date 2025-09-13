-- =====================================================
-- Add priority column to archon_tasks table
-- =====================================================
-- This migration adds a dedicated priority column to decouple
-- task priority from task_order field:
-- - priority: Enum field for semantic importance (low, medium, high, urgent)
-- - task_order: Remains for visual drag-and-drop positioning only
--
-- This solves the coupling issue where changing task position
-- accidentally changed task priority, enabling independent
-- priority management and visual task organization.
-- =====================================================

-- Drop existing enum if it exists to recreate with correct values
DROP TYPE IF EXISTS task_priority CASCADE;

-- Create enum type for task priority
CREATE TYPE task_priority AS ENUM ('low', 'medium', 'high', 'critical');

-- Add priority column to archon_tasks table
ALTER TABLE archon_tasks 
ADD COLUMN IF NOT EXISTS priority task_priority DEFAULT 'medium';

-- Add index for the priority column for better query performance
CREATE INDEX IF NOT EXISTS idx_archon_tasks_priority ON archon_tasks(priority);

-- Add comment to document the new column
COMMENT ON COLUMN archon_tasks.priority IS 'Task priority level independent of visual ordering - used for semantic importance (low, medium, high, urgent)';

-- Backfill existing data based on current task_order values
-- Map task_order ranges to priority levels:
-- 1-25: urgent (highest priority)
-- 26-50: high 
-- 51-75: medium
-- 76+: low (lowest priority)
UPDATE archon_tasks 
SET priority = 
  CASE 
    WHEN task_order <= 25 THEN 'critical'::task_priority
    WHEN task_order <= 50 THEN 'high'::task_priority  
    WHEN task_order <= 75 THEN 'medium'::task_priority
    ELSE 'low'::task_priority
  END
WHERE priority = 'medium';  -- Only update records with default priority

-- Note: After this migration, task_order will be used solely for
-- visual positioning in drag-and-drop operations, while priority
-- will be used for semantic importance and filtering