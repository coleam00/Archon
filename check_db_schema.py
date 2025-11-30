"""Script to check and optionally fix the PostgreSQL schema."""
import asyncio
import asyncpg


async def check_schema():
    """Check the current schema of site_pages table."""
    conn = await asyncpg.connect(
        host="localhost",
        port=5432,
        user="postgres",
        password="postgres",
        database="mydb"
    )

    try:
        # Get table schema
        schema = await conn.fetch("""
            SELECT
                column_name,
                data_type,
                column_default,
                is_nullable
            FROM information_schema.columns
            WHERE table_name = 'site_pages'
            ORDER BY ordinal_position
        """)

        print("Current site_pages schema:")
        print("-" * 80)
        for col in schema:
            print(f"{col['column_name']:20} {col['data_type']:20} "
                  f"DEFAULT: {col['column_default'] or 'NULL':30} "
                  f"NULLABLE: {col['is_nullable']}")

        # Check if id is UUID or INTEGER
        id_type = next((c['data_type'] for c in schema if c['column_name'] == 'id'), None)
        print(f"\n✓ ID column type: {id_type}")

        # Count existing records
        count = await conn.fetchval("SELECT COUNT(*) FROM site_pages")
        print(f"✓ Existing records: {count}")

        return id_type, count

    finally:
        await conn.close()


async def migrate_to_serial():
    """Migrate the id column from UUID to SERIAL."""
    conn = await asyncpg.connect(
        host="localhost",
        port=5432,
        user="postgres",
        password="postgres",
        database="mydb"
    )

    try:
        print("\n" + "=" * 80)
        print("MIGRATION: UUID → SERIAL (INTEGER)")
        print("=" * 80)

        # Check if table has data
        count = await conn.fetchval("SELECT COUNT(*) FROM site_pages")
        if count > 0:
            print(f"⚠️  WARNING: Table has {count} records. They will be DELETED!")
            response = input("Continue? (yes/no): ")
            if response.lower() != "yes":
                print("Migration cancelled.")
                return False

        # Drop and recreate table with correct schema
        await conn.execute("DROP TABLE IF EXISTS site_pages CASCADE")
        print("✓ Dropped existing table")

        await conn.execute("""
            CREATE TABLE site_pages (
                id SERIAL PRIMARY KEY,
                url TEXT NOT NULL,
                chunk_number INTEGER DEFAULT 0,
                title TEXT,
                summary TEXT,
                content TEXT,
                metadata JSONB DEFAULT '{}',
                embedding vector(1536),
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        """)
        print("✓ Created table with SERIAL id")

        # Create indexes
        await conn.execute("""
            CREATE INDEX site_pages_embedding_idx
            ON site_pages
            USING ivfflat (embedding vector_cosine_ops)
            WITH (lists = 100)
        """)
        print("✓ Created embedding index (ivfflat)")

        await conn.execute("CREATE INDEX site_pages_url_idx ON site_pages (url)")
        print("✓ Created url index")

        await conn.execute("""
            CREATE INDEX site_pages_metadata_source_idx
            ON site_pages ((metadata->>'source'))
        """)
        print("✓ Created metadata->source index")

        print("\n✅ Migration completed successfully!")
        return True

    except Exception as e:
        print(f"\n❌ Migration failed: {e}")
        return False
    finally:
        await conn.close()


async def main():
    print("PostgreSQL Schema Check and Migration Tool")
    print("=" * 80)

    try:
        id_type, count = await check_schema()

        if id_type == "uuid":
            print("\n⚠️  The id column is UUID, but the domain model expects INTEGER.")
            print("\nOptions:")
            print("  1. Migrate schema to SERIAL (INTEGER) - RECOMMENDED")
            print("  2. Keep UUID and adapt the repository implementation")
            print("  3. Cancel and decide later")

            choice = input("\nChoose option (1/2/3): ").strip()

            if choice == "1":
                success = await migrate_to_serial()
                if success:
                    print("\n✅ Schema is now compatible with domain model!")
            elif choice == "2":
                print("\n⚠️  You'll need to modify the domain model to support UUID.")
                print("This is NOT recommended as it breaks compatibility with existing code.")
            else:
                print("\nNo changes made.")

        elif id_type == "integer":
            print("\n✅ Schema is already compatible (INTEGER)!")

        else:
            print(f"\n❌ Unexpected id type: {id_type}")

    except Exception as e:
        print(f"\n❌ Error: {e}")


if __name__ == "__main__":
    asyncio.run(main())
