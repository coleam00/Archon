-- =====================================================
-- FIX: archon_page_metadata TABLE-LEVEL Permissions
-- =====================================================
-- RLS Policies already exist ✅
-- Only need to grant TABLE permissions
-- =====================================================

-- Grant TABLE-level permissions to all roles
GRANT ALL ON TABLE archon_page_metadata TO postgres;
GRANT ALL ON TABLE archon_page_metadata TO anon;
GRANT ALL ON TABLE archon_page_metadata TO authenticated;
GRANT ALL ON TABLE archon_page_metadata TO service_role;

-- Verify permissions were granted
-- Expected: 28 rows (7 privileges × 4 roles)
SELECT grantee, privilege_type
FROM information_schema.table_privileges
WHERE table_name = 'archon_page_metadata'
ORDER BY grantee, privilege_type;
