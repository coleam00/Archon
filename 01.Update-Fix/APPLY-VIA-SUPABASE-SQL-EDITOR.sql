-- =====================================================
-- APPLY VIA SUPABASE SQL EDITOR
-- =====================================================
-- Kopiere diesen Code in den Supabase SQL Editor:
-- http://localhost:8000/project/default/sql
-- =====================================================

-- 1. Drop old policies
DROP POLICY IF EXISTS "Allow service role full access to archon_page_metadata" ON archon_page_metadata;
DROP POLICY IF EXISTS "Allow authenticated users to read and update archon_page_metadata" ON archon_page_metadata;
DROP POLICY IF EXISTS "Allow authenticated users to read archon_page_metadata" ON archon_page_metadata;

-- 2. Create corrected RLS policies
CREATE POLICY "Allow service role full access to archon_page_metadata"
ON archon_page_metadata
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

CREATE POLICY "Allow authenticated users to read archon_page_metadata"
ON archon_page_metadata
FOR SELECT
TO authenticated
USING (true);

-- 3. Fix GRANT statements
REVOKE ALL ON TABLE archon_page_metadata FROM anon;
GRANT SELECT ON TABLE archon_page_metadata TO authenticated;

-- 4. Create updated_at trigger function
CREATE OR REPLACE FUNCTION archon_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 5. Create trigger
DROP TRIGGER IF EXISTS trg_archon_page_metadata_set_updated_at ON archon_page_metadata;
CREATE TRIGGER trg_archon_page_metadata_set_updated_at
BEFORE UPDATE ON archon_page_metadata
FOR EACH ROW EXECUTE FUNCTION archon_set_updated_at();

-- =====================================================
-- VERIFICATION QUERIES
-- =====================================================
-- Run these to verify:

-- Check policies:
SELECT schemaname, tablename, policyname, roles, cmd, qual
FROM pg_policies
WHERE tablename = 'archon_page_metadata';

-- Check grants:
SELECT grantee, privilege_type
FROM information_schema.table_privileges
WHERE table_name = 'archon_page_metadata'
ORDER BY grantee, privilege_type;

-- Check trigger:
SELECT tgname, tgtype, tgenabled
FROM pg_trigger
WHERE tgname = 'trg_archon_page_metadata_set_updated_at';
