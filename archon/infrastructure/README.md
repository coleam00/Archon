# Infrastructure Layer

This directory contains concrete implementations of domain interfaces using specific technologies.

## Structure

```
infrastructure/
├── __init__.py
├── README.md (this file)
├── supabase/
│   ├── __init__.py
│   ├── mappers.py                      # Conversion dict <-> domain models
│   └── site_pages_repository.py        # Supabase implementation
├── memory/
│   ├── __init__.py
│   └── site_pages_repository.py        # In-memory implementation for tests
└── openai/
    ├── __init__.py
    └── embedding_service.py             # OpenAI embedding service
```

## Implementations

### Repositories

#### SupabaseSitePagesRepository
Production repository implementation using Supabase as the backend.

**Usage:**
```python
from supabase import Client, create_client
from archon.infrastructure.supabase import SupabaseSitePagesRepository

# Initialize Supabase client
supabase_client = create_client(supabase_url, supabase_key)

# Create repository
repository = SupabaseSitePagesRepository(supabase_client)

# Use the repository
page = await repository.get_by_id(42)
```

**Features:**
- Full vector similarity search via Supabase RPC
- Batch operations for efficient inserts
- Metadata filtering via JSONB operators
- Automatic mapping between database and domain models

#### InMemorySitePagesRepository
In-memory implementation for testing without a database connection.

**Usage:**
```python
from archon.infrastructure.memory import InMemorySitePagesRepository

# Create repository
repository = InMemorySitePagesRepository()

# Use the repository
page = await repository.insert(new_page)

# Clear for next test
repository.clear()
```

**Features:**
- Pure Python implementation
- Cosine similarity calculation for vector search
- Fast and isolated for unit tests
- No external dependencies

### Embedding Services

#### OpenAIEmbeddingService
Production embedding service using OpenAI's API.

**Usage:**
```python
from openai import AsyncOpenAI
from archon.infrastructure.openai import OpenAIEmbeddingService

# Initialize OpenAI client
openai_client = AsyncOpenAI(api_key=api_key)

# Create embedding service
embedding_service = OpenAIEmbeddingService(
    client=openai_client,
    model="text-embedding-3-small"
)

# Generate embeddings
embedding = await embedding_service.get_embedding("How to build AI agents?")
```

**Features:**
- Async API for non-blocking operations
- Batch embedding support for efficiency
- Configurable model and dimensions
- Error handling and logging

## Mappers

The `supabase/mappers.py` module provides conversion functions:

- `dict_to_site_page(data)` - Convert Supabase dict to SitePage
- `site_page_to_dict(page)` - Convert SitePage to Supabase dict
- `dict_to_search_result(data)` - Convert search result dict to SearchResult

These mappers handle:
- Type conversions (datetime, JSONB, vectors)
- Optional field handling
- Pydantic model validation

## Testing

All infrastructure implementations have comprehensive unit tests in `tests/infrastructure/`:

- `test_mappers.py` - Tests for Supabase mappers
- `test_memory_repository.py` - Tests for in-memory repository
- More tests to be added for Supabase repository integration

Run tests:
```bash
pytest tests/infrastructure/ -v
```

## Logging

All infrastructure components use Python's logging module with structured logging:

- Logger name: `archon.repository.<implementation>`
- Debug level for method calls
- Info level for results
- Error level for exceptions

Enable logging:
```python
import logging
logging.basicConfig(level=logging.DEBUG)
```

## Adding New Implementations

To add a new repository or service implementation:

1. Create a new directory under `infrastructure/`
2. Implement the domain interface (ISitePagesRepository or IEmbeddingService)
3. Add logging for observability
4. Write comprehensive unit tests
5. Update this README
6. Export the implementation in `__init__.py`

Example:
```python
# infrastructure/postgres/site_pages_repository.py
from archon.domain.interfaces import ISitePagesRepository

class PostgresSitePagesRepository(ISitePagesRepository):
    def __init__(self, connection_pool):
        self.pool = connection_pool

    async def get_by_id(self, id: int):
        # Implementation here
        pass
```
