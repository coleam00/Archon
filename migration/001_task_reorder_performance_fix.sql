-- =====================================================
-- Migration: Task Reorder Performance Fix
-- =====================================================
-- File: 001_task_reorder_performance_fix.sql
-- Date: 2025-08-23
-- Description: Fixes the N+1 query performance issue in task creation
--              by replacing individual UPDATE loops with a single bulk UPDATE
-- 
-- Performance Impact:
-- - Before: 18+ seconds per task creation (N+1 queries)  
-- - After: <500ms per task creation (single UPDATE)
-- =====================================================

-- Drop any existing conflicting function versions
DROP FUNCTION IF EXISTS increment_task_order(UUID, TEXT, INTEGER, TEXT);

-- Create function for efficient task reordering
-- This replaces the expensive N+1 UPDATE pattern with a single bulk operation
CREATE OR REPLACE FUNCTION increment_task_order(
    p_project_id UUID,
    p_status task_status,  -- Use the correct enum type, not TEXT
    p_min_order INTEGER,
    p_updated_at TEXT
)
RETURNS VOID AS $$
DECLARE
    project_uuid UUID := p_project_id;
    status_val task_status := p_status;
    min_order_int INTEGER := p_min_order;
    updated_timestamp TIMESTAMPTZ := p_updated_at::TIMESTAMPTZ;
BEGIN
    -- Single UPDATE that increments all tasks at position p_min_order and higher
    -- This is much more efficient than individual UPDATE queries in a loop
    UPDATE archon_tasks 
    SET 
        task_order = task_order + 1,
        updated_at = updated_timestamp
    WHERE 
        project_id = project_uuid 
        AND status = status_val 
        AND task_order >= min_order_int;
END;
$$ LANGUAGE plpgsql;

-- Add function documentation
COMMENT ON FUNCTION increment_task_order IS 'Efficiently increments task_order for task reordering during creation. Fixes N+1 query performance issue.';

-- =====================================================
-- Migration Complete
-- =====================================================
-- This migration creates the increment_task_order function
-- that eliminates the task creation performance bottleneck.
--
-- To apply this migration:
-- 1. Run this SQL in your Supabase SQL Editor
-- 2. Restart your Archon server to use the optimized code
-- 
-- Expected Result:
-- - Task creation API calls: 18+ seconds → <500ms
-- - Bulk task operations will complete successfully
-- =====================================================