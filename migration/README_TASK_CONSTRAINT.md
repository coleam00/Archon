# Task Description Length Constraint

## Overview

This migration adds a database-level CHECK constraint to enforce the 50,000 character limit on task descriptions, providing defense in depth against potential bypasses of application-level validation.

## Why This Constraint?

1. **Defense in Depth**: While the application validates description length, database constraints prevent any bypass attempts
2. **Data Integrity**: Ensures consistency even if data is modified directly in the database
3. **Performance Protection**: Prevents extremely large descriptions that could impact query performance
4. **Compliance**: Follows the principle of enforcing business rules at multiple layers

## Current Implementation

### Application Layer (Already Implemented)
- Python service validates in `TaskService` class
- `MAX_DESCRIPTION_LENGTH = 50_000` constant
- Validation in both `create_task()` and `update_task()` methods
- Returns error if description exceeds limit

### Database Layer (This Migration)
- PostgreSQL CHECK constraint: `char_length(description) <= 50000`
- Applies to both INSERT and UPDATE operations
- Automatic enforcement by the database engine

## Migration Files

1. **`add_task_description_constraint.sql`**
   - Main SQL migration script
   - Checks for existing violations
   - Truncates oversized descriptions if found
   - Adds the CHECK constraint
   - Includes rollback instructions

2. **`apply_task_constraint.py`**
   - Python helper script for migration
   - Provides dry-run capability
   - Checks for violations before applying
   - Generates SQL commands for manual execution

## How to Apply

### Option 1: Direct SQL Execution (Recommended)

1. Connect to your Supabase SQL Editor
2. Run the migration script:
   ```sql
   -- Check and fix existing violations
   DO $$
   DECLARE
       violation_count INTEGER;
   BEGIN
       SELECT COUNT(*)
       INTO violation_count
       FROM archon_tasks
       WHERE description IS NOT NULL 
       AND char_length(description) > 50000;
       
       IF violation_count > 0 THEN
           -- Truncate oversized descriptions
           UPDATE archon_tasks
           SET description = LEFT(description, 49997) || '...'
           WHERE description IS NOT NULL 
           AND char_length(description) > 50000;
       END IF;
   END $$;

   -- Add the constraint
   ALTER TABLE archon_tasks
       ADD CONSTRAINT tasks_description_length_check
       CHECK (description IS NULL OR char_length(description) <= 50000);
   ```

### Option 2: Using Python Script

1. First, check for violations (dry run):
   ```bash
   cd /Users/philippbriese/Documents/Archon/Archon
   python migration/apply_task_constraint.py --dry-run
   ```

2. Apply the migration preparation:
   ```bash
   python migration/apply_task_constraint.py
   ```

3. Complete by running the generated SQL in Supabase SQL Editor

## Verification

After applying the constraint, verify it's working:

```sql
-- Check constraint exists
SELECT conname, contype, consrc 
FROM pg_constraint 
WHERE conname = 'tasks_description_length_check';

-- Test that it works (this should fail)
INSERT INTO archon_tasks (id, title, description, project_id) 
VALUES (
    gen_random_uuid(), 
    'Test Task', 
    REPEAT('x', 50001),  -- 50,001 characters
    gen_random_uuid()
);
-- Expected error: violates check constraint "tasks_description_length_check"
```

## Rollback

If you need to remove the constraint:

```sql
ALTER TABLE archon_tasks 
    DROP CONSTRAINT IF EXISTS tasks_description_length_check;
```

## Impact Analysis

### Performance Impact
- Minimal: CHECK constraints are evaluated during INSERT/UPDATE only
- No impact on SELECT queries
- Negligible overhead for constraint evaluation

### Compatibility
- Works with all PostgreSQL versions 9.0+
- Compatible with Supabase cloud and local instances
- No changes needed to application code

### Existing Data
- Migration script handles existing violations by truncation
- Preserves first 49,997 characters + "..." suffix
- Logs number of affected records

## Testing

### Unit Test Coverage
The constraint is tested via:
- `test_task_details_endpoint.py` - API endpoint tests
- Application-level validation tests

### Manual Testing
```python
# This should fail with the constraint
task_data = {
    "title": "Test Task",
    "description": "x" * 50001,  # Too long
    "project_id": "some-uuid"
}
# Expected: Database error - check constraint violation
```

## Security Considerations

1. **SQL Injection**: Constraint uses parameterized length check, not vulnerable
2. **DoS Prevention**: Limits memory usage for description fields
3. **Data Truncation**: Migration safely truncates with clear indication ("...")

## Monitoring

After deployment, monitor for:
- Constraint violation errors in logs
- User reports of truncated descriptions
- Performance metrics for task operations

## Future Considerations

1. Consider similar constraints for other text fields if needed
2. Evaluate if 50,000 is the optimal limit based on usage patterns
3. Could implement soft warnings at 45,000 characters in UI

## References

- [PostgreSQL CHECK Constraints Documentation](https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-CHECK-CONSTRAINTS)
- [Supabase Database Functions](https://supabase.com/docs/guides/database/functions)
- Beta Development Guidelines (CLAUDE.md)