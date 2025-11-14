-- =====================================================
-- ARCHON SECURITY FIX: RLS Policies & GRANT Statements
-- =====================================================
-- Fixes overly permissive RLS policies and table grants
-- for archon_page_metadata table.
--
-- Issues Fixed:
-- 1. RLS policy targeted 'public' instead of 'service_role'
-- 2. Authenticated users had FOR ALL instead of FOR SELECT
-- 3. anon role had GRANT but no policy (inconsistent)
-- 4. Missing updated_at trigger for automatic timestamp
--
-- Date: 2025-10-14
-- Source: CodeRabbit security review
-- =====================================================

-- Drop old policies (if they exist)
DROP POLICY IF EXISTS "Allow service role full access to archon_page_metadata" ON archon_page_metadata;
DROP POLICY IF EXISTS "Allow authenticated users to read and update archon_page_metadata" ON archon_page_metadata;
DROP POLICY IF EXISTS "Allow authenticated users to read archon_page_metadata" ON archon_page_metadata;

-- Create corrected RLS policies
-- Service role gets full access (for backend operations)
CREATE POLICY "Allow service role full access to archon_page_metadata"
ON archon_page_metadata
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- Authenticated users get read-only access
CREATE POLICY "Allow authenticated users to read archon_page_metadata"
ON archon_page_metadata
FOR SELECT
TO authenticated
USING (true);

-- Revoke old grants (clean slate)
REVOKE ALL ON TABLE archon_page_metadata FROM anon;
REVOKE ALL ON TABLE archon_page_metadata FROM authenticated;

-- Grant table-level permissions (least privilege)
-- Note: anon has no GRANT since there's no corresponding RLS policy (intentional)
GRANT SELECT ON TABLE archon_page_metadata TO authenticated;
GRANT ALL ON TABLE archon_page_metadata TO service_role;
GRANT ALL ON TABLE archon_page_metadata TO postgres;

-- Trigger function for automatic updated_at timestamp
CREATE OR REPLACE FUNCTION archon_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop trigger if exists (for clean re-apply)
DROP TRIGGER IF EXISTS trg_archon_page_metadata_set_updated_at ON archon_page_metadata;

-- Create trigger for updated_at
CREATE TRIGGER trg_archon_page_metadata_set_updated_at
BEFORE UPDATE ON archon_page_metadata
FOR EACH ROW EXECUTE FUNCTION archon_set_updated_at();

-- =====================================================
-- VERIFICATION
-- =====================================================
-- Check policies:
-- SELECT * FROM pg_policies WHERE tablename = 'archon_page_metadata';
--
-- Check grants:
-- SELECT grantee, privilege_type
-- FROM information_schema.table_privileges
-- WHERE table_name = 'archon_page_metadata';
--
-- Check trigger:
-- SELECT * FROM pg_trigger WHERE tgname = 'trg_archon_page_metadata_set_updated_at';
-- =====================================================

-- Success message
DO $$
BEGIN
  RAISE NOTICE '✅ Security fixes applied successfully!';
  RAISE NOTICE '   - RLS policies restricted to service_role';
  RAISE NOTICE '   - Authenticated users: read-only (SELECT)';
  RAISE NOTICE '   - anon role: no access (GRANT removed)';
  RAISE NOTICE '   - updated_at trigger: created';
END;
$$;
