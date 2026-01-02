# Database Abstraction Layer

> Repository Pattern implementation for flexible database backends

---

## Overview

This document describes the database abstraction layer introduced in the Archon codebase. The implementation follows the **Repository Pattern** with **Dependency Injection**, allowing seamless switching between database backends without modifying business logic.

### Supported Backends

| Backend | Use Case | Configuration |
|---------|----------|---------------|
| **Supabase** | Cloud deployment, existing users | `REPOSITORY_TYPE=supabase` |
| **PostgreSQL** | Self-hosted, full control | `REPOSITORY_TYPE=postgres` |
| **InMemory** | Unit tests, development | `REPOSITORY_TYPE=memory` |

---

## Architecture

```
+------------------------------------------------------------------+
|                        APPLICATION LAYER                          |
|  FastAPI endpoints, MCP tools, Services                          |
+------------------------------------------------------------------+
                               |
                               v
+------------------------------------------------------------------+
|                          CONTAINER                                |
|  Singleton with async lifecycle management                        |
|  - initialize() / shutdown()                                      |
|  - Provides repository instances                                  |
+------------------------------------------------------------------+
                               |
                               v
+------------------------------------------------------------------+
|                        DOMAIN LAYER                               |
|  +---------------------------+  +---------------------------+     |
|  |       Interfaces          |  |         Models            |     |
|  | - ICrawledPagesRepository |  | - CrawledPage             |     |
|  | - ISourcesRepository      |  | - Source                  |     |
|  | - ICodeExamplesRepository |  | - CodeExample             |     |
|  +---------------------------+  | - SearchResult            |     |
|                                 +---------------------------+     |
+------------------------------------------------------------------+
                               |
                               v
+------------------------------------------------------------------+
|                     INFRASTRUCTURE LAYER                          |
|  +----------------+  +----------------+  +----------------+       |
|  |    Supabase    |  |   PostgreSQL   |  |    InMemory    |       |
|  | (supabase-py)  |  | (asyncpg)      |  | (dict + lock)  |       |
|  +----------------+  +----------------+  +----------------+       |
+------------------------------------------------------------------+
```

---

## Quick Start

### Configuration

Set the `REPOSITORY_TYPE` environment variable:

```bash
# Use Supabase (default, cloud)
export REPOSITORY_TYPE=supabase
export SUPABASE_URL=https://xxx.supabase.co
export SUPABASE_SERVICE_KEY=your-key

# Use PostgreSQL (self-hosted)
export REPOSITORY_TYPE=postgres
export POSTGRES_HOST=localhost
export POSTGRES_PORT=5432
export POSTGRES_DB=archon
export POSTGRES_USER=archon
export POSTGRES_PASSWORD=secret

# Use InMemory (tests)
export REPOSITORY_TYPE=memory
```

### Usage in Code

```python
from src.server.container import container

# Initialize on startup (in FastAPI lifespan)
await container.initialize()

# Get repositories
pages_repo = container.crawled_pages_repository
sources_repo = container.sources_repository
examples_repo = container.code_examples_repository

# Use repositories (same API regardless of backend)
pages = await pages_repo.search_similar(
    embedding=query_embedding,
    match_count=10,
    source_id="my-docs"
)

# Shutdown on exit
await container.shutdown()
```

---

## Domain Layer

### Interfaces

All repository implementations must implement these interfaces:

#### ICrawledPagesRepository

```python
class ICrawledPagesRepository(ABC):
    async def insert(self, page: CrawledPageCreate) -> CrawledPage
    async def insert_batch(self, pages: list[CrawledPageCreate]) -> list[CrawledPage]
    async def get_by_id(self, page_id: str) -> CrawledPage | None
    async def find_by_url(self, url: str) -> list[CrawledPage]
    async def find_by_source(self, source_id: str) -> list[CrawledPage]
    async def search_similar(
        self,
        embedding: list[float],
        match_count: int = 10,
        source_id: str | None = None,
        similarity_threshold: float = 0.0
    ) -> list[SearchResult[CrawledPage]]
    async def delete_by_url(self, url: str) -> int
    async def delete_by_source(self, source_id: str) -> int
    async def count(self, source_id: str | None = None) -> int
```

#### ISourcesRepository

```python
class ISourcesRepository(ABC):
    async def create(self, source: SourceCreate) -> Source
    async def get_by_id(self, source_id: str) -> Source | None
    async def get_by_url(self, url: str) -> Source | None
    async def list_all(self) -> list[Source]
    async def search(self, query: str) -> list[Source]
    async def update(self, source_id: str, data: dict) -> Source | None
    async def update_status(self, source_id: str, status: str) -> None
    async def update_counts(self, source_id: str, pages_count: int = None, chunks_count: int = None) -> None
    async def delete(self, source_id: str) -> bool
    async def count(self) -> int
```

#### ICodeExamplesRepository

```python
class ICodeExamplesRepository(ABC):
    async def insert(self, example: CodeExampleCreate) -> CodeExample
    async def insert_batch(self, examples: list[CodeExampleCreate]) -> list[CodeExample]
    async def get_by_id(self, example_id: str) -> CodeExample | None
    async def find_by_source(self, source_id: str) -> list[CodeExample]
    async def find_by_page_url(self, page_url: str) -> list[CodeExample]
    async def search_similar(
        self,
        embedding: list[float],
        match_count: int = 10,
        source_id: str | None = None,
        language: str | None = None
    ) -> list[SearchResult[CodeExample]]
    async def delete_by_source(self, source_id: str) -> int
    async def delete_by_page_url(self, page_url: str) -> int
    async def count(self, source_id: str | None = None) -> int
    async def list_languages(self, source_id: str | None = None) -> list[str]
```

### Models

All models are Pydantic BaseModels with validation:

```python
from src.server.domain.models import (
    CrawledPage,
    CrawledPageCreate,
    Source,
    SourceCreate,
    CodeExample,
    CodeExampleCreate,
    SearchResult,
)
```

---

## Infrastructure Layer

### Supabase Backend

Uses the official `supabase-py` client with RPC calls for vector search.

**Requirements:**
- Supabase project with pgvector extension enabled
- Tables: `site_pages`, `sources`, `code_examples`
- RPC functions for vector similarity search

**Configuration:**
```bash
REPOSITORY_TYPE=supabase
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=eyJ...
```

### PostgreSQL Backend

Uses `asyncpg` for async database access with native pgvector support.

**Requirements:**
- PostgreSQL 14+ with pgvector extension
- Connection pool management (handled by Container)

**Configuration:**
```bash
REPOSITORY_TYPE=postgres
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=archon
POSTGRES_USER=archon
POSTGRES_PASSWORD=secret
```

**Vector Search Query:**
```sql
SELECT *, (embedding_1536 <=> $1::vector) as distance
FROM site_pages
WHERE source_id = $2
ORDER BY distance ASC
LIMIT $3
```

### InMemory Backend

Pure Python implementation using dictionaries with thread-safe locking.

**Use Cases:**
- Unit tests (fast, no external dependencies)
- Local development without database
- CI/CD pipelines

**Configuration:**
```bash
REPOSITORY_TYPE=memory
```

**Vector Search Implementation:**
```python
def cosine_similarity(vec_a: list[float], vec_b: list[float]) -> float:
    """Pure Python cosine similarity, returns value in [0, 1]."""
    dot = sum(a * b for a, b in zip(vec_a, vec_b))
    mag_a = sqrt(sum(a * a for a in vec_a))
    mag_b = sqrt(sum(b * b for b in vec_b))
    if mag_a == 0 or mag_b == 0:
        return 0.0
    return max(0.0, min(1.0, dot / (mag_a * mag_b)))
```

---

## Container (Dependency Injection)

The `Container` class manages repository lifecycle and provides singleton access:

```python
from src.server.container import container, Container

# Check if initialized
if container.is_initialized:
    print(f"Storage type: {container.storage_type}")

# Get health status
health = await container.health_check()
# Returns: {"storage_type": "memory", "initialized": True, "healthy": True}

# Convenience functions
from src.server.container import (
    get_crawled_pages_repository,
    get_sources_repository,
    get_code_examples_repository,
)

repo = get_crawled_pages_repository()  # Returns cached instance
```

### Lifecycle Management

```python
# In FastAPI lifespan (main.py)
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    await container.initialize()
    logger.info(f"Container initialized (storage: {container.storage_type})")

    yield

    # Shutdown
    await container.shutdown()
    logger.info("Container shutdown complete")
```

---

## Multi-Dimension Embeddings

The system supports multiple embedding dimensions via dynamic column selection:

| Dimension | Column | Typical Model |
|-----------|--------|---------------|
| 768 | `embedding_768` | sentence-transformers |
| 1024 | `embedding_1024` | text-embedding-3-small |
| 1536 | `embedding_1536` | text-embedding-ada-002 |
| 3072 | `embedding_3072` | text-embedding-3-large |

The `CrawledPageCreate` model specifies which dimension to use:

```python
page = CrawledPageCreate(
    url="https://docs.example.com/page",
    content="Page content...",
    source_id="my-docs",
    embedding=[0.1, 0.2, ...],  # Your embedding vector
    embedding_dimension=1536,    # Specifies target column
    embedding_model="text-embedding-ada-002"
)
```

---

## Testing

### Unit Tests with InMemory

```python
import pytest
from src.server.infrastructure.memory import InMemoryCrawledPagesRepository
from src.server.domain.models import CrawledPageCreate

@pytest.fixture
def repo():
    repository = InMemoryCrawledPagesRepository()
    yield repository
    repository.clear()

@pytest.mark.asyncio
async def test_insert_and_retrieve(repo):
    page = CrawledPageCreate(
        url="https://test.com",
        content="Test content",
        source_id="test",
        chunk_number=0,
    )

    created = await repo.insert(page)
    found = await repo.get_by_id(created.id)

    assert found is not None
    assert found.content == "Test content"
```

### Contract Tests

Verify all implementations respect the interface contract:

```python
class CrawledPagesRepositoryContract:
    """Contract tests - run against any implementation."""

    @pytest.fixture
    @abstractmethod
    def repo(self) -> ICrawledPagesRepository:
        pass

    @pytest.mark.asyncio
    async def test_insert_and_get_by_id(self, repo):
        # ... test implementation
        pass

class TestInMemoryContract(CrawledPagesRepositoryContract):
    @pytest.fixture
    def repo(self):
        return InMemoryCrawledPagesRepository()

class TestPostgresContract(CrawledPagesRepositoryContract):
    @pytest.fixture
    def repo(self, postgres_pool):
        return PostgresCrawledPagesRepository(postgres_pool)
```

---

## Adding a New Backend

To add a new database backend (e.g., MongoDB):

### 1. Create Implementation

```python
# src/server/infrastructure/mongodb/crawled_pages_repository.py
from src.server.domain.interfaces import ICrawledPagesRepository

class MongoCrawledPagesRepository(ICrawledPagesRepository):
    def __init__(self, client: MongoClient):
        self._client = client
        self._collection = client.archon.crawled_pages

    async def insert(self, page: CrawledPageCreate) -> CrawledPage:
        # Implementation
        pass

    # ... implement all interface methods
```

### 2. Register in Factory

```python
# src/server/infrastructure/repository_factory.py

def get_crawled_pages_repository() -> ICrawledPagesRepository:
    repo_type = os.getenv("REPOSITORY_TYPE", "supabase")

    if repo_type == "mongodb":
        from .mongodb import MongoCrawledPagesRepository
        return MongoCrawledPagesRepository(get_mongo_client())
    # ... other backends
```

### 3. Add Contract Tests

```python
class TestMongoContract(CrawledPagesRepositoryContract):
    @pytest.fixture
    def repo(self, mongo_client):
        return MongoCrawledPagesRepository(mongo_client)
```

---

## Migration Guide

### From Direct Supabase Calls

**Before:**
```python
from supabase import create_client

supabase = create_client(url, key)
result = supabase.table("site_pages").select("*").eq("source_id", source_id).execute()
```

**After:**
```python
from src.server.container import container

await container.initialize()
repo = container.crawled_pages_repository
pages = await repo.find_by_source(source_id)
```

### Switching Backends

Simply change the environment variable:

```bash
# From Supabase to PostgreSQL
export REPOSITORY_TYPE=postgres
export POSTGRES_HOST=localhost
# ... other postgres vars

# Restart application
```

No code changes required - the Container handles backend selection automatically.

---

## Troubleshooting

### Container not initialized

```python
# Error: Container not initialized
# Solution: Call initialize() before accessing repositories

await container.initialize()
repo = container.crawled_pages_repository  # Now works
```

### PostgreSQL connection failed

```bash
# Check environment variables
echo $POSTGRES_HOST $POSTGRES_PORT $POSTGRES_DB

# Verify PostgreSQL is running
pg_isready -h localhost -p 5432

# Check pgvector extension
psql -c "SELECT * FROM pg_extension WHERE extname = 'vector';"
```

### Vector search returns no results

```python
# Check embedding dimension matches
page = await repo.get_by_id(page_id)
print(f"Has embedding_1536: {page.embedding_1536 is not None}")

# Verify search threshold
results = await repo.search_similar(
    embedding=query_embedding,
    similarity_threshold=0.0  # Lower threshold for debugging
)
```

---

## File Structure

```
python/src/server/
+-- domain/
|   +-- interfaces/
|   |   +-- crawled_pages_repository.py
|   |   +-- sources_repository.py
|   |   +-- code_examples_repository.py
|   +-- models/
|       +-- crawled_page.py
|       +-- source.py
|       +-- code_example.py
|       +-- search_result.py
+-- infrastructure/
|   +-- repository_factory.py
|   +-- supabase/
|   |   +-- crawled_pages_repository.py
|   |   +-- sources_repository.py
|   |   +-- code_examples_repository.py
|   +-- postgres/
|   |   +-- crawled_pages_repository.py
|   |   +-- sources_repository.py
|   |   +-- code_examples_repository.py
|   +-- memory/
|       +-- vector_utils.py
|       +-- crawled_pages_repository.py
|       +-- sources_repository.py
|       +-- code_examples_repository.py
+-- container.py
```

---

## References

- [Repository Pattern](https://martinfowler.com/eaaCatalog/repository.html) - Martin Fowler
- [pgvector](https://github.com/pgvector/pgvector) - Vector similarity for PostgreSQL
- [asyncpg](https://github.com/MagicStack/asyncpg) - Fast PostgreSQL client for Python
- [Pydantic](https://docs.pydantic.dev/) - Data validation using Python type hints
