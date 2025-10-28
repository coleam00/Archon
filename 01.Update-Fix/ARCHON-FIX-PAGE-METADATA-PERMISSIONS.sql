-- =====================================================
-- FIX: archon_page_metadata Permissions
-- =====================================================
-- Problem: Migration 011_add_page_metadata_table.sql
-- created table but forgot to set permissions
--
-- Execute in: Supabase Dashboard SQL Editor
-- URL: http://localhost:9001/project/default/sql
-- =====================================================

-- Step 1: Enable Row Level Security
ALTER TABLE archon_page_metadata ENABLE ROW LEVEL SECURITY;

-- Step 2: Create RLS Policies (Row-level access control)
CREATE POLICY "Allow service role full access to archon_page_metadata"
ON archon_page_metadata
FOR ALL
TO public
USING (true)
WITH CHECK (true);

CREATE POLICY "Allow authenticated users to read and update archon_page_metadata"
ON archon_page_metadata
FOR ALL
TO authenticated
USING (true)
WITH CHECK (true);

-- Step 3: Grant TABLE-level permissions (CRITICAL!)
-- This is what was missing - without this, service_role gets "permission denied"
GRANT ALL ON TABLE archon_page_metadata TO postgres;
GRANT ALL ON TABLE archon_page_metadata TO anon;
GRANT ALL ON TABLE archon_page_metadata TO authenticated;
GRANT ALL ON TABLE archon_page_metadata TO service_role;

-- Step 4: Verify permissions were granted
-- Expected: 28 rows (7 privileges × 4 roles)
SELECT grantee, privilege_type
FROM information_schema.table_privileges
WHERE table_name = 'archon_page_metadata'
ORDER BY grantee, privilege_type;

-- Step 5: Verify RLS policies are active
-- Expected: 2 rows (service_role + authenticated policies)
SELECT tablename, policyname, roles, cmd
FROM pg_policies
WHERE tablename = 'archon_page_metadata';

-- =====================================================
-- Expected Output After Fix:
-- =====================================================
-- Table Privileges (28 rows):
--   anon          | DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
--   authenticated | DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
--   postgres      | DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
--   service_role  | DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE
--
-- RLS Policies (2 rows):
--   Allow service role full access to archon_page_metadata
--   Allow authenticated users to read and update archon_page_metadata
-- =====================================================

-- Test: Try to insert a test row (should succeed)
-- Uncomment to test:
-- INSERT INTO archon_page_metadata (source_id, url, full_content, word_count, char_count, chunk_count)
-- VALUES ('test', 'http://test.com', 'Test content', 2, 12, 0);
--
-- Clean up test:
-- DELETE FROM archon_page_metadata WHERE source_id = 'test';
