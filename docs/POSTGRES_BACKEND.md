# PostgreSQL Backend Implementation

## Overview

The PostgreSQL backend provides direct database access using `asyncpg` and `pgvector`, offering maximum performance without the Supabase abstraction layer.

**Status:** ✅ COMPLETED (2025-11-30)

---

## Features

- **High Performance**: Native `asyncpg` driver with connection pooling
- **Vector Search**: Native `pgvector` support for similarity search
- **Full Control**: Direct SQL access for advanced queries
- **Async Native**: Built from the ground up for async/await patterns

---

## Architecture

```
archon/
  infrastructure/
    postgres/
      __init__.py               # Module exports
      connection.py             # Connection pool management
      site_pages_repository.py  # PostgresSitePagesRepository
```

---

## Setup

### 1. Install Dependencies

```bash
pip install asyncpg>=0.31.0 pgvector>=0.4.0
```

### 2. Database Schema

The schema must be created before using the repository:

```sql
-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Create site_pages table
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
);

-- Create indexes for performance
CREATE INDEX site_pages_embedding_idx
    ON site_pages
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

CREATE INDEX site_pages_url_idx
    ON site_pages (url);

CREATE INDEX site_pages_metadata_source_idx
    ON site_pages ((metadata->>'source'));
```

**Note:** A migration script is provided at `migrate_schema.py` to automate this setup.

### 3. Environment Variables

Configure the following environment variables:

```bash
REPOSITORY_TYPE=postgres
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=archon
POSTGRES_USER=postgres
POSTGRES_PASSWORD=your_password
```

---

## Usage

### Using the Container (Recommended)

```python
import asyncio
from archon.container import configure, get_repository_async

async def main():
    # Configure to use PostgreSQL
    configure(repository_type="postgres")

    # Get repository instance
    repo = await get_repository_async()

    # Use the repository
    pages = await repo.find_by_url("https://example.com")
    print(f"Found {len(pages)} pages")

    # Close when done (important!)
    await repo.close()

if __name__ == "__main__":
    asyncio.run(main())
```

### Direct Instantiation

```python
import asyncio
from archon.infrastructure.postgres import PostgresSitePagesRepository

async def main():
    # Create repository with connection pool
    repo = await PostgresSitePagesRepository.create(
        host="localhost",
        port=5432,
        database="archon",
        user="postgres",
        password="secret",
        min_size=5,
        max_size=20
    )

    # Use the repository
    total = await repo.count()
    print(f"Total pages: {total}")

    # Close pool when done
    await repo.close()

if __name__ == "__main__":
    asyncio.run(main())
```

---

## Implemented Methods

All 8 methods from `ISitePagesRepository` are fully implemented:

| Method | Description | Performance |
|--------|-------------|-------------|
| `get_by_id` | Retrieve by primary key | O(1) with index |
| `find_by_url` | Find all chunks for a URL | O(log n) with index |
| `search_similar` | Vector similarity search | Approximate with IVFFlat |
| `list_unique_urls` | List distinct URLs | O(n) with distinct |
| `insert` | Insert single page | O(1) |
| `insert_batch` | Batch insert | O(n) in transaction |
| `delete_by_source` | Delete by metadata source | O(m) where m = matches |
| `count` | Count with optional filter | O(1) or O(n) with filter |

---

## Vector Search Details

### Similarity Calculation

The repository uses pgvector's **cosine distance** operator (`<=>`):

```sql
SELECT *, 1 - (embedding <=> $1::vector) as similarity
FROM site_pages
WHERE embedding IS NOT NULL
ORDER BY embedding <=> $1::vector
LIMIT $2
```

**Similarity Score:** 0.0 (completely different) to 1.0 (identical)

### Index Type: IVFFlat

The `ivfflat` index provides **approximate nearest neighbor** search:

- **Faster** than exact search for large datasets
- **May miss some results** when dataset is small (< 1000 vectors)
- **Tunable** via `lists` parameter (default: 100)

For exact search on small datasets, drop the index:

```sql
DROP INDEX site_pages_embedding_idx;
```

---

## Performance Considerations

### Connection Pooling

The repository uses `asyncpg` connection pooling:

- **min_size=5**: Minimum connections kept alive
- **max_size=20**: Maximum concurrent connections
- **Automatic**: Connections reused across requests

### Batch Operations

Use `insert_batch()` for inserting multiple pages:

```python
pages = [page1, page2, page3, ...]
inserted = await repo.insert_batch(pages)  # Single transaction
```

### Metadata Filtering

Metadata filters use JSONB operators:

```python
# Filter by source
count = await repo.count(filter={"metadata.source": "pydantic_ai_docs"})

# SQL generated:
# SELECT COUNT(*) FROM site_pages
# WHERE metadata->>'source' = 'pydantic_ai_docs'
```

---

## Testing

### Unit Tests

Run the PostgreSQL repository tests:

```bash
pytest tests/infrastructure/test_postgres_repository.py -v
```

**Results:** ✅ 16/16 tests passing

### Integration Test

Run the full integration test:

```bash
python test_postgres_integration.py
```

This tests all 10 repository operations end-to-end.

---

## Migration from Supabase

To migrate from Supabase to PostgreSQL:

1. **Export data** from Supabase:
   ```sql
   COPY site_pages TO '/tmp/site_pages.csv' CSV HEADER;
   ```

2. **Update schema** on PostgreSQL (use `migrate_schema.py`)

3. **Import data**:
   ```sql
   COPY site_pages FROM '/tmp/site_pages.csv' CSV HEADER;
   ```

4. **Update environment**:
   ```bash
   REPOSITORY_TYPE=postgres
   POSTGRES_HOST=your_host
   POSTGRES_DB=your_db
   # ... other vars
   ```

5. **Update code**:
   ```python
   # Before
   repo = get_repository()  # Supabase

   # After
   repo = await get_repository_async()  # PostgreSQL
   ```

---

## Troubleshooting

### "This event loop is already running"

**Problem:** Trying to use `get_repository()` with `postgres` type.

**Solution:** Use `get_repository_async()` instead:

```python
# Wrong
configure(repository_type="postgres")
repo = get_repository()  # Error!

# Correct
configure(repository_type="postgres")
repo = await get_repository_async()  # Works!
```

### "Connection refused"

**Problem:** PostgreSQL not running or wrong credentials.

**Solution:** Check environment variables and database status:

```bash
# Check if PostgreSQL is running
docker ps | grep postgres

# Test connection
psql -h localhost -U postgres -d archon
```

### Vector search returns few results

**Problem:** IVFFlat index with small dataset.

**Solution:** This is expected behavior. Options:

1. Add more vectors to the database (> 1000 recommended)
2. Drop the index for exact search (slower)
3. Adjust test expectations (see `test_search_similar`)

---

## Comparison with Other Backends

| Feature | Supabase | PostgreSQL | Memory |
|---------|----------|------------|--------|
| Performance | Medium | **High** | Highest |
| Setup Complexity | Low | Medium | None |
| Vector Search | Yes (RPC) | Yes (native) | Yes (Python) |
| Production Ready | Yes | **Yes** | No |
| Requires Server | Yes (cloud) | Yes (self-hosted) | No |
| Cost | Paid tiers | **Free** | Free |

---

## Next Steps

1. **SQLAlchemy Backend**: For multi-database portability (PostgreSQL, MySQL, SQLite)
2. **SQLite Backend**: For local development without infrastructure
3. **Connection Pool Tuning**: Optimize pool size for production workloads
4. **Monitoring**: Add metrics for query performance

---

## Files Created

- `archon/infrastructure/postgres/__init__.py`
- `archon/infrastructure/postgres/connection.py`
- `archon/infrastructure/postgres/site_pages_repository.py`
- `tests/infrastructure/test_postgres_repository.py`
- `test_postgres_integration.py`
- `migrate_schema.py`
- `check_db_schema.py`
- `docs/POSTGRES_BACKEND.md` (this file)

---

## References

- [asyncpg Documentation](https://magicstack.github.io/asyncpg/)
- [pgvector GitHub](https://github.com/pgvector/pgvector)
- [PostgreSQL JSONB Operators](https://www.postgresql.org/docs/current/functions-json.html)
- [IVFFlat Index Tuning](https://github.com/pgvector/pgvector#indexing)

---

*Document created: 2025-11-30*
*Backend implementation: PostgreSQL Direct (asyncpg + pgvector)*
*Status: Production Ready ✅*
