#!/usr/bin/env python3
"""
Apply task description length constraint migration.

This script safely applies the CHECK constraint to enforce a 50,000 character
limit on task descriptions at the database level.

Usage:
    python apply_task_constraint.py [--dry-run] [--rollback]
"""

import argparse
import os
import sys
from pathlib import Path
from typing import Optional, Tuple

# Add parent directory to path for imports
sys.path.append(str(Path(__file__).parent.parent))

from python.src.server.config.db_config import get_supabase_client


def check_violations(supabase) -> Tuple[int, Optional[int]]:
    """Check for existing descriptions that exceed the limit."""
    try:
        # Query for violations
        result = supabase.table("archon_tasks").select("id, description").execute()
        
        violations = []
        max_length = 0
        
        for task in result.data:
            if task.get("description"):
                desc_length = len(task["description"])
                if desc_length > 50000:
                    violations.append(task["id"])
                    max_length = max(max_length, desc_length)
        
        return len(violations), max_length if violations else None
    except Exception as e:
        print(f"Error checking violations: {e}")
        return 0, None


def truncate_violations(supabase, dry_run: bool = False) -> int:
    """Truncate descriptions that exceed the limit."""
    try:
        result = supabase.table("archon_tasks").select("id, description").execute()
        
        truncated_count = 0
        for task in result.data:
            if task.get("description") and len(task["description"]) > 50000:
                if not dry_run:
                    truncated_desc = task["description"][:49997] + "..."
                    supabase.table("archon_tasks").update({
                        "description": truncated_desc
                    }).eq("id", task["id"]).execute()
                truncated_count += 1
                print(f"{'Would truncate' if dry_run else 'Truncated'} task {task['id']}")
        
        return truncated_count
    except Exception as e:
        print(f"Error truncating descriptions: {e}")
        return 0


def apply_constraint(supabase, dry_run: bool = False) -> bool:
    """Apply the CHECK constraint to the database."""
    if dry_run:
        print("DRY RUN: Would apply CHECK constraint (char_length(description) <= 50000)")
        return True
    
    try:
        # Read the SQL migration file
        migration_file = Path(__file__).parent / "add_task_description_constraint.sql"
        with open(migration_file, "r") as f:
            sql = f.read()
        
        # Execute via raw SQL (requires direct database connection)
        print("Note: Constraint must be applied directly in Supabase SQL Editor")
        print(f"Please execute the following SQL file: {migration_file}")
        print("\nAlternatively, run this SQL command:")
        print("""
ALTER TABLE archon_tasks
    ADD CONSTRAINT tasks_description_length_check
    CHECK (description IS NULL OR char_length(description) <= 50000);
        """)
        return True
    except Exception as e:
        print(f"Error applying constraint: {e}")
        return False


def rollback_constraint(supabase) -> bool:
    """Remove the CHECK constraint from the database."""
    print("To rollback, execute this SQL in Supabase SQL Editor:")
    print("""
ALTER TABLE archon_tasks 
    DROP CONSTRAINT IF EXISTS tasks_description_length_check;
    """)
    return True


def main():
    parser = argparse.ArgumentParser(
        description="Apply task description length constraint migration"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be done without making changes"
    )
    parser.add_argument(
        "--rollback",
        action="store_true",
        help="Remove the constraint instead of adding it"
    )
    args = parser.parse_args()
    
    # Get Supabase client
    try:
        supabase = get_supabase_client()
        print("Connected to Supabase successfully")
    except Exception as e:
        print(f"Failed to connect to Supabase: {e}")
        sys.exit(1)
    
    if args.rollback:
        print("\n=== ROLLBACK MODE ===")
        if rollback_constraint(supabase):
            print("Rollback instructions provided successfully")
        else:
            print("Rollback failed")
            sys.exit(1)
    else:
        print("\n=== MIGRATION: Add Task Description Length Constraint ===")
        print("Maximum allowed length: 50,000 characters")
        
        # Step 1: Check for violations
        print("\n1. Checking for existing violations...")
        violation_count, max_length = check_violations(supabase)
        
        if violation_count > 0:
            print(f"   Found {violation_count} task(s) exceeding the limit")
            print(f"   Maximum length found: {max_length} characters")
            
            # Step 2: Truncate violations
            print("\n2. Truncating oversized descriptions...")
            truncated = truncate_violations(supabase, dry_run=args.dry_run)
            print(f"   {'Would truncate' if args.dry_run else 'Truncated'} {truncated} description(s)")
        else:
            print("   No violations found - all descriptions are within limit")
        
        # Step 3: Apply constraint
        print("\n3. Applying CHECK constraint...")
        if apply_constraint(supabase, dry_run=args.dry_run):
            print("   Constraint application instructions provided")
            print("\n=== MIGRATION PREPARATION COMPLETE ===")
            if not args.dry_run:
                print("\nIMPORTANT: To complete the migration, execute the SQL")
                print("constraint in your Supabase SQL Editor as shown above.")
        else:
            print("   Failed to apply constraint")
            sys.exit(1)


if __name__ == "__main__":
    main()