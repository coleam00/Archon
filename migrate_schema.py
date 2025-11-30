"""Migrate PostgreSQL schema from UUID to SERIAL."""
import asyncio
import asyncpg


async def migrate():
    """Migrate the id column from UUID to SERIAL."""
    conn = await asyncpg.connect(
        host="localhost",
        port=5432,
        user="postgres",
        password="postgres",
        database="mydb"
    )

    try:
        print("\nMigration: UUID -> SERIAL (INTEGER)")
        print("=" * 60)

        # Check if table has data
        count = await conn.fetchval("SELECT COUNT(*) FROM site_pages")
        print(f"Current records: {count}")

        if count > 0:
            print(f"\nWARNING: Table has {count} records.")
            print("They will be DELETED during migration!")
            response = input("\nContinue? (yes/no): ")
            if response.lower() != "yes":
                print("\nMigration cancelled.")
                return False

        # Drop and recreate table with correct schema
        print("\nDropping existing table...")
        await conn.execute("DROP TABLE IF EXISTS site_pages CASCADE")

        print("Creating table with SERIAL id...")
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

        # Create indexes
        print("Creating embedding index (ivfflat)...")
        await conn.execute("""
            CREATE INDEX site_pages_embedding_idx
            ON site_pages
            USING ivfflat (embedding vector_cosine_ops)
            WITH (lists = 100)
        """)

        print("Creating url index...")
        await conn.execute("CREATE INDEX site_pages_url_idx ON site_pages (url)")

        print("Creating metadata->source index...")
        await conn.execute("""
            CREATE INDEX site_pages_metadata_source_idx
            ON site_pages ((metadata->>'source'))
        """)

        print("\n[SUCCESS] Migration completed!")
        print("Schema is now compatible with domain model.")
        return True

    except Exception as e:
        print(f"\n[ERROR] Migration failed: {e}")
        import traceback
        traceback.print_exc()
        return False
    finally:
        await conn.close()


if __name__ == "__main__":
    print("PostgreSQL Schema Migration Tool")
    print("This will convert the id column from UUID to SERIAL")
    asyncio.run(migrate())
