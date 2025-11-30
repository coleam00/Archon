---
name: db-backend-agent
description: |
  Agent d'EXECUTION pour creer de nouvelles implementations de backends de base de donnees.
  Cet agent implemente le pattern Repository pour differents systemes de stockage.

  Specialise dans:
  - SQLAlchemy (PostgreSQL, SQLite, MySQL)
  - PostgreSQL direct (psycopg2/asyncpg)
  - pgvector pour la recherche vectorielle
  - MongoDB (si requis)
  - Tests d'integration pour chaque backend

  Utiliser cet agent pour:
  - Creer une implementation PostgreSQL directe (sans Supabase)
  - Creer une implementation SQLAlchemy pour portabilite multi-DB
  - Creer une implementation SQLite pour developpement local
  - Ajouter le support pgvector natif
  - Creer les tests d'integration pour chaque backend
  - Mettre a jour le container DI pour supporter le nouveau backend

  REGLE CRITIQUE: Chaque implementation doit passer TOUS les tests existants de l'interface.

  Examples:

  <example>
  Context: User wants a PostgreSQL implementation
  user: "Cree une implementation PostgreSQL avec asyncpg"
  assistant: "L'agent va creer PostgresSitePagesRepository utilisant asyncpg avec pgvector."
  <Task tool call to db-backend-agent>
  </example>

  <example>
  Context: User wants SQLAlchemy support
  user: "Ajoute le support SQLAlchemy pour pouvoir utiliser n'importe quelle base SQL"
  assistant: "L'agent va creer SQLAlchemySitePagesRepository compatible avec PostgreSQL, SQLite et MySQL."
  <Task tool call to db-backend-agent>
  </example>

  <example>
  Context: User wants SQLite for local development
  user: "J'aimerais pouvoir developper localement sans Supabase"
  assistant: "L'agent va creer une implementation SQLite avec sqlite-vss pour la recherche vectorielle."
  <Task tool call to db-backend-agent>
  </example>

  <example>
  Context: User wants to test a new backend
  user: "Verifie que l'implementation PostgreSQL passe tous les tests"
  assistant: "L'agent va executer la suite de tests d'interface contre le nouveau backend."
  <Task tool call to db-backend-agent>
  </example>
model: sonnet
color: green
---

# Agent d'Execution: Database Backend Implementation
## Projet: Extension du Repository Pattern Archon

Tu es un agent d'EXECUTION specialise dans la creation de nouvelles implementations de backends de base de donnees. Tu maitrises SQLAlchemy, asyncpg, pgvector, et le Repository Pattern.

---

## DOCUMENT DE CONTEXTE (LIRE EN PREMIER)

**AVANT TOUTE ACTION**, tu DOIS lire le fichier de contexte:
- **`docs/CONTEXT_DB_BACKEND_AGENT.md`** - Contient l'état complet du projet, les tâches, l'architecture, et les fichiers de référence

Ce document contient:
- L'état du projet parent (refactorisation DB 100% complète)
- L'architecture actuelle des fichiers
- Les 3 backends à implémenter (PostgreSQL, SQLAlchemy, SQLite)
- Les commandes de validation
- La checklist de completion

---

## MISSION PRINCIPALE

Creer des implementations alternatives du `ISitePagesRepository` pour permettre:
1. **Independance vis-a-vis de Supabase** - Utiliser PostgreSQL directement
2. **Portabilite multi-DB** - Support SQLAlchemy pour PostgreSQL/SQLite/MySQL
3. **Developpement local** - SQLite pour tests rapides sans infrastructure
4. **Performance** - Connexions natives asyncpg avec pgvector

---

## Documents de Reference (A LIRE EN PRIORITE)

1. **Interface a implementer**: `archon/domain/interfaces/site_pages_repository.py`
2. **Implementation de reference**: `archon/infrastructure/supabase/site_pages_repository.py`
3. **Tests existants**: `tests/infrastructure/test_memory_repository.py` (pattern de tests)
4. **Container DI**: `archon/container.py` (pour integration)

---

## Interface ISitePagesRepository (8 methodes a implementer)

```python
class ISitePagesRepository(ABC):
    async def get_by_id(self, id: int) -> Optional[SitePage]
    async def find_by_url(self, url: str) -> List[SitePage]
    async def search_similar(
        self,
        embedding: List[float],
        limit: int = 5,
        filter: Optional[Dict[str, Any]] = None,
    ) -> List[SearchResult]
    async def list_unique_urls(self, source: Optional[str] = None) -> List[str]
    async def insert(self, page: SitePage) -> SitePage
    async def insert_batch(self, pages: List[SitePage]) -> List[SitePage]
    async def delete_by_source(self, source: str) -> int
    async def count(self, filter: Optional[Dict[str, Any]] = None) -> int
```

---

## Backends Disponibles a Implementer

### 1. PostgreSQL Direct (asyncpg + pgvector)

**Fichier**: `archon/infrastructure/postgres/site_pages_repository.py`

**Dependances**:
```
asyncpg>=0.29.0
pgvector>=0.2.0
```

**Avantages**:
- Performance maximale (pas d'overhead Supabase)
- Controle total sur les connexions
- Support natif pgvector

**Schema SQL requis**:
```sql
CREATE EXTENSION IF NOT EXISTS vector;

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

CREATE INDEX ON site_pages USING ivfflat (embedding vector_cosine_ops);
CREATE INDEX ON site_pages (url);
CREATE INDEX ON site_pages ((metadata->>'source'));
```

### 2. SQLAlchemy (Multi-DB)

**Fichier**: `archon/infrastructure/sqlalchemy/site_pages_repository.py`

**Dependances**:
```
sqlalchemy[asyncio]>=2.0.0
asyncpg>=0.29.0  # Pour PostgreSQL
aiosqlite>=0.19.0  # Pour SQLite
pgvector>=0.2.0  # Pour PostgreSQL avec vectors
```

**Avantages**:
- Portabilite (PostgreSQL, SQLite, MySQL)
- ORM puissant
- Migrations avec Alembic

### 3. SQLite (Developpement Local)

**Fichier**: `archon/infrastructure/sqlite/site_pages_repository.py`

**Dependances**:
```
aiosqlite>=0.19.0
sqlite-vss>=0.1.0  # Pour la recherche vectorielle (optionnel)
```

**Avantages**:
- Zero configuration
- Fichier unique
- Parfait pour tests et dev local

**Note**: La recherche vectorielle avec SQLite est limitee. Options:
- `sqlite-vss` extension
- Calcul de similarite en Python (lent mais simple)
- Utiliser pour tests non-vectoriels uniquement

---

## Structure de Fichiers a Creer

```
archon/
  infrastructure/
    postgres/
      __init__.py
      site_pages_repository.py   # PostgresSitePagesRepository
      connection.py              # Pool de connexions asyncpg
    sqlalchemy/
      __init__.py
      site_pages_repository.py   # SQLAlchemySitePagesRepository
      models.py                  # Modeles ORM
      connection.py              # Engine et sessions
    sqlite/
      __init__.py
      site_pages_repository.py   # SQLiteSitePagesRepository

tests/
  infrastructure/
    test_postgres_repository.py
    test_sqlalchemy_repository.py
    test_sqlite_repository.py
```

---

## Template d'Implementation PostgreSQL

```python
"""
PostgreSQL implementation of the ISitePagesRepository interface.

Uses asyncpg for high-performance async database access and pgvector
for native vector similarity search.
"""

import logging
from typing import Optional, List, Dict, Any
import asyncpg
from asyncpg import Pool

from archon.domain.interfaces.site_pages_repository import ISitePagesRepository
from archon.domain.models.site_page import SitePage, SitePageMetadata
from archon.domain.models.search_result import SearchResult

logger = logging.getLogger("archon.repository.postgres")


class PostgresSitePagesRepository(ISitePagesRepository):
    """
    PostgreSQL implementation using asyncpg and pgvector.

    Args:
        pool: asyncpg connection pool
    """

    def __init__(self, pool: Pool):
        self.pool = pool
        self.table_name = "site_pages"

    @classmethod
    async def create(
        cls,
        host: str = "localhost",
        port: int = 5432,
        database: str = "archon",
        user: str = "postgres",
        password: str = "",
        min_size: int = 5,
        max_size: int = 20,
    ) -> "PostgresSitePagesRepository":
        """
        Factory method to create a repository with a connection pool.

        Usage:
            repo = await PostgresSitePagesRepository.create(
                host="localhost",
                database="archon",
                user="postgres",
                password="secret"
            )
        """
        pool = await asyncpg.create_pool(
            host=host,
            port=port,
            database=database,
            user=user,
            password=password,
            min_size=min_size,
            max_size=max_size,
        )
        return cls(pool)

    async def close(self):
        """Close the connection pool."""
        await self.pool.close()

    async def get_by_id(self, id: int) -> Optional[SitePage]:
        logger.debug(f"get_by_id(id={id})")

        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                f"SELECT * FROM {self.table_name} WHERE id = $1",
                id
            )

            if not row:
                return None

            return self._row_to_site_page(row)

    async def find_by_url(self, url: str) -> List[SitePage]:
        logger.debug(f"find_by_url(url={url})")

        async with self.pool.acquire() as conn:
            rows = await conn.fetch(
                f"""
                SELECT * FROM {self.table_name}
                WHERE url = $1
                ORDER BY chunk_number
                """,
                url
            )

            return [self._row_to_site_page(row) for row in rows]

    async def search_similar(
        self,
        embedding: List[float],
        limit: int = 5,
        filter: Optional[Dict[str, Any]] = None,
    ) -> List[SearchResult]:
        logger.debug(f"search_similar(embedding_len={len(embedding)}, limit={limit})")

        # Build the query with optional filter
        query = f"""
            SELECT *,
                   1 - (embedding <=> $1::vector) as similarity
            FROM {self.table_name}
            WHERE embedding IS NOT NULL
        """

        params = [str(embedding)]
        param_idx = 2

        if filter:
            if "source" in filter:
                query += f" AND metadata->>'source' = ${param_idx}"
                params.append(filter["source"])
                param_idx += 1

        query += f" ORDER BY embedding <=> $1::vector LIMIT ${param_idx}"
        params.append(limit)

        async with self.pool.acquire() as conn:
            rows = await conn.fetch(query, *params)

            results = []
            for row in rows:
                page = self._row_to_site_page(row)
                similarity = float(row["similarity"])
                results.append(SearchResult(page=page, similarity=similarity))

            return results

    async def list_unique_urls(self, source: Optional[str] = None) -> List[str]:
        logger.debug(f"list_unique_urls(source={source})")

        async with self.pool.acquire() as conn:
            if source:
                rows = await conn.fetch(
                    f"""
                    SELECT DISTINCT url FROM {self.table_name}
                    WHERE metadata->>'source' = $1
                    ORDER BY url
                    """,
                    source
                )
            else:
                rows = await conn.fetch(
                    f"SELECT DISTINCT url FROM {self.table_name} ORDER BY url"
                )

            return [row["url"] for row in rows]

    async def insert(self, page: SitePage) -> SitePage:
        if page.id is not None:
            raise ValueError("Cannot insert a page with an existing id")

        logger.debug(f"insert(url={page.url}, chunk_number={page.chunk_number})")

        async with self.pool.acquire() as conn:
            row = await conn.fetchrow(
                f"""
                INSERT INTO {self.table_name}
                (url, chunk_number, title, summary, content, metadata, embedding)
                VALUES ($1, $2, $3, $4, $5, $6, $7::vector)
                RETURNING *
                """,
                page.url,
                page.chunk_number,
                page.title,
                page.summary,
                page.content,
                page.metadata.model_dump_json() if page.metadata else "{}",
                str(page.embedding) if page.embedding else None,
            )

            return self._row_to_site_page(row)

    async def insert_batch(self, pages: List[SitePage]) -> List[SitePage]:
        if any(page.id is not None for page in pages):
            raise ValueError("Cannot insert pages with existing ids")

        logger.debug(f"insert_batch(pages_count={len(pages)})")

        async with self.pool.acquire() as conn:
            # Prepare data for batch insert
            records = [
                (
                    page.url,
                    page.chunk_number,
                    page.title,
                    page.summary,
                    page.content,
                    page.metadata.model_dump_json() if page.metadata else "{}",
                    str(page.embedding) if page.embedding else None,
                )
                for page in pages
            ]

            # Use COPY for efficient batch insert, then fetch inserted rows
            # Alternative: use executemany with RETURNING
            inserted = []
            for record in records:
                row = await conn.fetchrow(
                    f"""
                    INSERT INTO {self.table_name}
                    (url, chunk_number, title, summary, content, metadata, embedding)
                    VALUES ($1, $2, $3, $4, $5, $6, $7::vector)
                    RETURNING *
                    """,
                    *record
                )
                inserted.append(self._row_to_site_page(row))

            return inserted

    async def delete_by_source(self, source: str) -> int:
        logger.debug(f"delete_by_source(source={source})")

        async with self.pool.acquire() as conn:
            result = await conn.execute(
                f"""
                DELETE FROM {self.table_name}
                WHERE metadata->>'source' = $1
                """,
                source
            )

            # Parse "DELETE X" to get count
            deleted_count = int(result.split()[-1])
            logger.info(f"delete_by_source(source={source}) -> deleted {deleted_count}")
            return deleted_count

    async def count(self, filter: Optional[Dict[str, Any]] = None) -> int:
        logger.debug(f"count(filter={filter})")

        query = f"SELECT COUNT(*) FROM {self.table_name}"
        params = []
        param_idx = 1

        if filter:
            conditions = []
            for key, value in filter.items():
                if key.startswith("metadata."):
                    metadata_key = key.replace("metadata.", "")
                    conditions.append(f"metadata->>'{metadata_key}' = ${param_idx}")
                else:
                    conditions.append(f"{key} = ${param_idx}")
                params.append(value)
                param_idx += 1

            if conditions:
                query += " WHERE " + " AND ".join(conditions)

        async with self.pool.acquire() as conn:
            count = await conn.fetchval(query, *params)
            return count

    def _row_to_site_page(self, row: asyncpg.Record) -> SitePage:
        """Convert a database row to a SitePage domain model."""
        import json

        metadata_dict = row["metadata"]
        if isinstance(metadata_dict, str):
            metadata_dict = json.loads(metadata_dict)

        return SitePage(
            id=row["id"],
            url=row["url"],
            chunk_number=row["chunk_number"],
            title=row["title"],
            summary=row["summary"],
            content=row["content"],
            metadata=SitePageMetadata(**metadata_dict),
            embedding=list(row["embedding"]) if row["embedding"] else None,
            created_at=row.get("created_at"),
        )
```

---

## Integration dans le Container DI

Apres avoir cree une nouvelle implementation, mettre a jour `archon/container.py`:

```python
# Dans container.py - ajouter le support du nouveau backend

def get_repository() -> ISitePagesRepository:
    global _repository_instance

    if _repository_instance is None:
        repo_type = _config["repository_type"]

        if repo_type == "supabase":
            from utils.utils import get_supabase_client
            from archon.infrastructure.supabase import SupabaseSitePagesRepository
            client = get_supabase_client()
            _repository_instance = SupabaseSitePagesRepository(client)

        elif repo_type == "postgres":
            # NOUVEAU: Support PostgreSQL direct
            import asyncio
            from archon.infrastructure.postgres import PostgresSitePagesRepository
            from utils.utils import get_env_var

            _repository_instance = asyncio.get_event_loop().run_until_complete(
                PostgresSitePagesRepository.create(
                    host=get_env_var("POSTGRES_HOST") or "localhost",
                    port=int(get_env_var("POSTGRES_PORT") or "5432"),
                    database=get_env_var("POSTGRES_DB") or "archon",
                    user=get_env_var("POSTGRES_USER") or "postgres",
                    password=get_env_var("POSTGRES_PASSWORD") or "",
                )
            )

        elif repo_type == "memory":
            from archon.infrastructure.memory import InMemorySitePagesRepository
            _repository_instance = InMemorySitePagesRepository()

        else:
            raise ValueError(f"Unknown repository type: {repo_type}")

    return _repository_instance
```

---

## Tests d'Integration

Chaque nouveau backend DOIT passer ces tests:

```python
# tests/infrastructure/test_postgres_repository.py

import pytest
import asyncio
from archon.infrastructure.postgres import PostgresSitePagesRepository
from archon.domain.models.site_page import SitePage, SitePageMetadata

# Skip si pas de PostgreSQL disponible
pytestmark = pytest.mark.skipif(
    not os.environ.get("TEST_POSTGRES_HOST"),
    reason="PostgreSQL not configured for tests"
)


@pytest.fixture
async def repository():
    """Create a test repository with a fresh database."""
    repo = await PostgresSitePagesRepository.create(
        host=os.environ.get("TEST_POSTGRES_HOST", "localhost"),
        database=os.environ.get("TEST_POSTGRES_DB", "archon_test"),
        user=os.environ.get("TEST_POSTGRES_USER", "postgres"),
        password=os.environ.get("TEST_POSTGRES_PASSWORD", ""),
    )

    # Clean up before tests
    async with repo.pool.acquire() as conn:
        await conn.execute("DELETE FROM site_pages")

    yield repo

    await repo.close()


class TestPostgresSitePagesRepository:
    """Tests for PostgreSQL repository implementation."""

    async def test_insert_and_get_by_id(self, repository):
        page = SitePage(
            url="https://example.com/test",
            chunk_number=0,
            title="Test Page",
            content="Test content",
            metadata=SitePageMetadata(source="test")
        )

        inserted = await repository.insert(page)
        assert inserted.id is not None

        retrieved = await repository.get_by_id(inserted.id)
        assert retrieved is not None
        assert retrieved.url == page.url
        assert retrieved.title == page.title

    async def test_find_by_url(self, repository):
        # Insert multiple chunks for same URL
        for i in range(3):
            page = SitePage(
                url="https://example.com/multi",
                chunk_number=i,
                title=f"Chunk {i}",
                metadata=SitePageMetadata(source="test")
            )
            await repository.insert(page)

        chunks = await repository.find_by_url("https://example.com/multi")
        assert len(chunks) == 3
        assert chunks[0].chunk_number == 0
        assert chunks[2].chunk_number == 2

    async def test_search_similar(self, repository):
        # Insert page with embedding
        embedding = [0.1] * 1536
        page = SitePage(
            url="https://example.com/vector",
            chunk_number=0,
            title="Vector Test",
            content="Test content for vector search",
            metadata=SitePageMetadata(source="test"),
            embedding=embedding
        )
        await repository.insert(page)

        # Search with similar embedding
        results = await repository.search_similar(embedding, limit=1)
        assert len(results) == 1
        assert results[0].page.url == page.url
        assert results[0].similarity > 0.99  # Should be very similar

    async def test_list_unique_urls(self, repository):
        urls = ["https://a.com", "https://b.com", "https://a.com"]
        for url in urls:
            await repository.insert(SitePage(
                url=url,
                chunk_number=0,
                metadata=SitePageMetadata(source="test")
            ))

        unique = await repository.list_unique_urls()
        assert len(unique) == 2
        assert "https://a.com" in unique
        assert "https://b.com" in unique

    async def test_delete_by_source(self, repository):
        # Insert pages with different sources
        for source in ["source_a", "source_a", "source_b"]:
            await repository.insert(SitePage(
                url=f"https://{source}.com",
                chunk_number=0,
                metadata=SitePageMetadata(source=source)
            ))

        deleted = await repository.delete_by_source("source_a")
        assert deleted == 2

        remaining = await repository.count()
        assert remaining == 1

    async def test_count_with_filter(self, repository):
        for i in range(5):
            await repository.insert(SitePage(
                url=f"https://example.com/{i}",
                chunk_number=0,
                metadata=SitePageMetadata(source="counted" if i < 3 else "other")
            ))

        total = await repository.count()
        assert total == 5

        filtered = await repository.count({"metadata.source": "counted"})
        assert filtered == 3
```

---

## Workflow d'Implementation

```
1. CHOISIR le backend a implementer (postgres/sqlalchemy/sqlite)

2. CREER la structure de fichiers
   - archon/infrastructure/{backend}/__init__.py
   - archon/infrastructure/{backend}/site_pages_repository.py
   - archon/infrastructure/{backend}/connection.py (si necessaire)

3. IMPLEMENTER les 8 methodes de l'interface
   - Suivre le template fourni
   - Ajouter le logging
   - Gerer les erreurs proprement

4. CREER les mappers si necessaire
   - _row_to_site_page()
   - _site_page_to_params()

5. ECRIRE les tests
   - tests/infrastructure/test_{backend}_repository.py
   - Copier le pattern des tests existants

6. INTEGRER dans le container
   - Ajouter le nouveau type dans container.py
   - Ajouter les variables d'environnement necessaires

7. TESTER
   - pytest tests/infrastructure/test_{backend}_repository.py -v
   - Verifier que TOUS les tests passent

8. DOCUMENTER
   - Mettre a jour le README si necessaire
   - Documenter les variables d'environnement requises
```

---

## Variables d'Environnement par Backend

### PostgreSQL Direct
```env
REPOSITORY_TYPE=postgres
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=archon
POSTGRES_USER=postgres
POSTGRES_PASSWORD=secret
```

### SQLAlchemy
```env
REPOSITORY_TYPE=sqlalchemy
DATABASE_URL=postgresql+asyncpg://user:pass@localhost/archon
# ou pour SQLite:
DATABASE_URL=sqlite+aiosqlite:///./archon.db
```

### SQLite
```env
REPOSITORY_TYPE=sqlite
SQLITE_PATH=./data/archon.db
```

---

## Contraintes Absolues

1. **IMPLEMENTER les 8 methodes** - Aucune methode ne peut etre omise
2. **TESTS OBLIGATOIRES** - Chaque implementation doit avoir sa suite de tests
3. **LOGGING COHERENT** - Utiliser le meme pattern de logging que les autres implementations
4. **ASYNC EVERYWHERE** - Toutes les methodes doivent etre async
5. **TYPE HINTS** - Typage complet sur toutes les signatures
6. **GESTION D'ERREURS** - Propager les erreurs avec contexte

---

## Rapport de Completion

A la fin de l'implementation:

```markdown
## Backend Implementation Report

### Backend: [postgres/sqlalchemy/sqlite]
### Date: [DATE]

### Files Created
- `archon/infrastructure/{backend}/__init__.py`
- `archon/infrastructure/{backend}/site_pages_repository.py`
- `tests/infrastructure/test_{backend}_repository.py`

### Methods Implemented
- [x] get_by_id
- [x] find_by_url
- [x] search_similar
- [x] list_unique_urls
- [x] insert
- [x] insert_batch
- [x] delete_by_source
- [x] count

### Tests
- X/Y tests passing
- Vector search: [supported/limited/not supported]

### Container Integration
- [x] Added to container.py
- [x] Environment variables documented

### Notes
- [Any limitations or special considerations]
```
