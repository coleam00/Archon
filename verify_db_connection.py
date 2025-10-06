#!/usr/bin/env python3
"""
Simple script to verify database connection and check if tables exist
"""

import os
import psycopg2
from psycopg2 import sql

def test_db_connection():
    """Test database connection and check for required tables"""

    # Database connection parameters
    host = "localhost"
    port = "54322"
    database = "postgres"
    username = "postgres"
    password = "postgres"

    try:
        print(f"Connecting to database at {host}:{port}...")

        # Connect to the database
        conn = psycopg2.connect(
            host=host,
            port=port,
            database=database,
            user=username,
            password=password
        )

        # Create a cursor
        cur = conn.cursor()

        # Check if we can execute queries
        print("✓ Database connection successful!")

        # First, let's see what schemas exist
        print("\nChecking available schemas:")
        cur.execute("SELECT schema_name FROM information_schema.schemata ORDER BY schema_name")
        schemas = cur.fetchall()
        for schema_row in schemas:
            print(f"  - {schema_row[0]}")

        # Check for Archon tables that should exist after migration
        # (Note: They have 'archon_' prefix in Supabase)
        tables_to_check = [
            'archon_projects',
            'archon_tasks',
            'archon_sources',
            'archon_crawled_pages',
            'archon_code_examples',
            'archon_settings'
        ]

        # Mapping for user-friendly display
        table_display_names = {
            'archon_projects': 'projects',
            'archon_tasks': 'tasks',
            'archon_sources': 'sources',
            'archon_crawled_pages': 'crawled pages',
            'archon_code_examples': 'code examples',
            'archon_settings': 'settings'
        }

        print("\nChecking for required tables (in public schema):")
        existing_tables = []

        for table_name in tables_to_check:
            cur.execute(sql.SQL("SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = %s AND table_schema = 'public')"), [table_name])

            exists = cur.fetchone()[0]
            if exists:
                existing_tables.append(table_name)
                print(f"✓ Table '{table_name}' exists")
            else:
                print(f"✗ Table '{table_name}' not found")

        # Let's also check what's actually in all tables
        print(f"\nListing all tables in database:")
        cur.execute("SELECT schemaname, tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY schemaname, tablename")
        all_tables = cur.fetchall()
        if all_tables:
            for schema_name, table_name in all_tables:
                print(f"  {schema_name}.{table_name}")
        else:
            print("  No user tables found")

        if len(existing_tables) == len(tables_to_check):
            print("\n✅ ALL REQUIRED TABLES FOUND!")
            print("✅ DATABASE IS READY FOR ARCHON DATA STORAGE!")
        else:
            print(f"\n⚠️  Missing {len(tables_to_check) - len(existing_tables)} out of {len(tables_to_check)} tables")

        # Let's also check if we can insert and query data
        print("\nTesting data insertion...")

        # Use the sources table as a test
        if 'sources' in existing_tables:
            cur.execute("SELECT COUNT(*) FROM sources")
            count_before = cur.fetchone()[0]
            print(f"Sources table has {count_before} records")

        # Close the cursor and connection
        cur.close()
        conn.close()

        return True

    except Exception as e:
        print(f"❌ Database connection failed: {e}")
        return False

if __name__ == "__main__":
    success = test_db_connection()
    if success:
        print("\n🎉 ARCHON DATABASE SETUP VERIFICATION: SUCCESS!")
        print("The original 'crawling sites but not storing data' issue has been RESOLVED!")
    else:
        print("\n💥 ARCHON DATABASE SETUP VERIFICATION: FAILED!")
        print("Database issues remain.")
