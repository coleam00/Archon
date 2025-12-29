# Architecture de la Database Layer - Archon

> Documentation de l'architecture en couches pour le système de gestion de la base de connaissances d'Archon

## Table des matières

1. [Vue d'ensemble](#vue-densemble)
2. [Architecture en couches](#architecture-en-couches)
3. [Container DI (Dependency Injection)](#container-di-dependency-injection)
4. [Domain Layer](#domain-layer)
5. [Infrastructure Layer](#infrastructure-layer)
6. [Guide d'utilisation](#guide-dutilisation)
7. [Tests](#tests)
8. [Ajouter un nouveau backend](#ajouter-un-nouveau-backend)

---

## Vue d'ensemble

L'architecture de la database layer d'Archon suit les principes de **Clean Architecture** et **Domain-Driven Design (DDD)**, avec une séparation claire entre:

- **Domain**: Logique métier et contrats (interfaces)
- **Infrastructure**: Implémentations concrètes des contrats
- **Application**: Services applicatifs et points d'entrée

Cette architecture permet de:
- Changer de backend de base de données sans modifier la logique métier
- Tester facilement avec des implémentations en mémoire
- Respecter le principe d'inversion de dépendances (SOLID)

---

## Architecture en couches

```
┌─────────────────────────────────────────────────────────────┐
│                    Application Layer                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ agent_tools  │  │  crawlers    │  │  streamlit   │      │
│  │     .py      │  │     .py      │  │   pages      │      │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘      │
│         │                 │                 │               │
│         └─────────────────┴─────────────────┘               │
│                           │                                 │
│                           ▼                                 │
│                  ┌─────────────────┐                        │
│                  │  Container DI   │                        │
│                  │  (Injection)    │                        │
│                  └────────┬────────┘                        │
└──────────────────────────┼──────────────────────────────────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
          ▼                ▼                ▼
┌─────────────────────────────────────────────────────────────┐
│                      Domain Layer                            │
│                                                              │
│  ┌────────────────────────────────────────────────────┐    │
│  │              Interfaces (Contracts)                 │    │
│  │                                                     │    │
│  │  ISitePagesRepository         IEmbeddingService    │    │
│  │  (abstract methods)            (abstract methods)  │    │
│  └────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌────────────────────────────────────────────────────┐    │
│  │                   Models                            │    │
│  │                                                     │    │
│  │  SitePage          SearchResult                    │    │
│  │  SitePageMetadata                                  │    │
│  └────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
                           │
          ┌────────────────┼────────────────┐
          │                │                │
          ▼                ▼                ▼
┌─────────────────────────────────────────────────────────────┐
│                  Infrastructure Layer                        │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │   Supabase   │  │  PostgreSQL  │  │   Memory     │     │
│  │  Repository  │  │  Repository  │  │  Repository  │     │
│  │              │  │              │  │              │     │
│  │ (pgvector    │  │ (asyncpg +   │  │ (in-memory   │     │
│  │  via SDK)    │  │  pgvector)   │  │   dict)      │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐                        │
│  │   OpenAI     │  │     Mock     │                        │
│  │  Embedding   │  │  Embedding   │                        │
│  │   Service    │  │   Service    │                        │
│  └──────────────┘  └──────────────┘                        │
└──────────────────────────────────────────────────────────────┘
```

### Flux de dépendances

```
Application → Container → Domain (Interfaces) ← Infrastructure (Implementations)
```

**Principe clé**: L'Application et l'Infrastructure dépendent du Domain, mais **jamais l'inverse**.

---

## Container DI (Dependency Injection)

Le Container DI (`archon/container.py`) est le point central d'injection de dépendances. Il permet de:

1. **Configurer** quel backend utiliser (Supabase, PostgreSQL, Memory)
2. **Obtenir** des instances configurées des repositories et services
3. **Override** pour les tests (injection de mocks)

### API du Container

```python
from archon.container import (
    configure,
    get_repository,
    get_repository_async,
    get_embedding_service,
    reset,
    override_repository,
    override_embedding_service,
)
```

#### Fonctions principales

| Fonction | Description | Retour |
|----------|-------------|--------|
| `configure(repository_type, embedding_type)` | Configure le type de backend | `None` |
| `get_repository()` | Retourne le repository (sync) | `ISitePagesRepository` |
| `get_repository_async()` | Retourne le repository (async) | `ISitePagesRepository` |
| `get_embedding_service()` | Retourne le service d'embedding | `IEmbeddingService` |
| `reset()` | Reset les instances (pour tests) | `None` |
| `override_repository(repo)` | Override le repository (pour tests) | `None` |
| `override_embedding_service(svc)` | Override le service (pour tests) | `None` |

### Configuration

Le container peut être configuré de **deux façons**:

#### 1. Via variables d'environnement (recommandé pour production)

```bash
# Dans .env ou workbench/env_vars.json
REPOSITORY_TYPE=postgres  # ou "supabase", "memory"

# PostgreSQL
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=archon
POSTGRES_USER=postgres
POSTGRES_PASSWORD=secret

# Embedding
EMBEDDING_API_KEY=sk-...
```

```python
# Le container lit automatiquement REPOSITORY_TYPE
repo = await get_repository_async()
```

#### 2. Via `configure()` (recommandé pour tests)

```python
from archon.container import configure, get_repository

# Configuration explicite
configure(repository_type="memory", embedding_type="mock")

# Récupération
repo = get_repository()
embedding = get_embedding_service()
```

### Singleton Pattern

Le container maintient des **instances singleton** de chaque service:

```python
repo1 = get_repository()
repo2 = get_repository()

assert repo1 is repo2  # True - même instance
```

Pour obtenir une nouvelle instance, utilisez `reset()`:

```python
reset()
repo3 = get_repository()

assert repo1 is not repo3  # True - nouvelle instance
```

---

## Domain Layer

Le Domain Layer (`archon/domain/`) contient la **logique métier pure**, indépendante de toute infrastructure.

### Structure

```
archon/domain/
├── __init__.py           # Exports publics
├── models/
│   ├── site_page.py      # SitePage, SitePageMetadata
│   ├── search_result.py  # SearchResult
│   └── __init__.py
└── interfaces/
    ├── site_pages_repository.py  # ISitePagesRepository
    ├── embedding_service.py      # IEmbeddingService
    └── __init__.py
```

### Models

#### SitePage

Représente une page ou chunk de documentation stocké dans la base de données.

```python
from archon.domain import SitePage, SitePageMetadata

page = SitePage(
    id=None,  # Auto-généré par le repository
    url="https://ai.pydantic.dev/agents/",
    chunk_number=0,
    title="Agents - Pydantic AI",
    summary="Introduction to building agents",
    content="Full text content here...",
    metadata=SitePageMetadata(
        source="pydantic_ai_docs",
        chunk_size=1500,
        crawled_at=datetime.now(),
        url_path="/agents/"
    ),
    embedding=[0.1, 0.2, ...],  # 1536 dimensions (OpenAI)
    created_at=None  # Auto-généré
)
```

**Attributs clés**:
- `id`: Identifiant unique (auto-généré)
- `url`: URL complète de la page
- `chunk_number`: Index du chunk (une URL peut avoir plusieurs chunks)
- `embedding`: Vecteur d'embedding pour la recherche vectorielle
- `metadata`: Métadonnées extensibles (permet des champs supplémentaires)

#### SearchResult

Résultat d'une recherche par similarité vectorielle.

```python
from archon.domain import SearchResult

result = SearchResult(
    page=site_page,       # SitePage
    similarity=0.87       # Score de similarité (0-1)
)
```

### Interfaces

#### ISitePagesRepository

Contrat pour l'accès aux pages de documentation.

```python
from archon.domain import ISitePagesRepository

class ISitePagesRepository(ABC):
    @abstractmethod
    async def get_by_id(self, id: int) -> Optional[SitePage]:
        """Récupérer une page par ID."""
        pass

    @abstractmethod
    async def find_by_url(self, url: str) -> List[SitePage]:
        """Trouver tous les chunks d'une URL."""
        pass

    @abstractmethod
    async def search_similar(
        self,
        embedding: List[float],
        limit: int = 5,
        filter: Optional[Dict[str, Any]] = None,
    ) -> List[SearchResult]:
        """Recherche par similarité vectorielle."""
        pass

    @abstractmethod
    async def list_unique_urls(self, source: Optional[str] = None) -> List[str]:
        """Lister toutes les URLs uniques."""
        pass

    @abstractmethod
    async def insert(self, page: SitePage) -> SitePage:
        """Insérer une nouvelle page."""
        pass

    @abstractmethod
    async def insert_batch(self, pages: List[SitePage]) -> List[SitePage]:
        """Insérer plusieurs pages en batch."""
        pass

    @abstractmethod
    async def delete_by_source(self, source: str) -> int:
        """Supprimer toutes les pages d'une source."""
        pass

    @abstractmethod
    async def count(self, filter: Optional[Dict[str, Any]] = None) -> int:
        """Compter les pages."""
        pass
```

**Toutes les méthodes sont async** pour supporter les opérations I/O efficaces.

#### IEmbeddingService

Contrat pour générer des embeddings vectoriels.

```python
from archon.domain import IEmbeddingService

class IEmbeddingService(ABC):
    @abstractmethod
    async def get_embedding(self, text: str) -> List[float]:
        """Générer un embedding pour du texte."""
        pass
```

---

## Infrastructure Layer

L'Infrastructure Layer (`archon/infrastructure/`) contient les **implémentations concrètes** des interfaces du domain.

### Structure

```
archon/infrastructure/
├── __init__.py
├── supabase/
│   ├── site_pages_repository.py   # SupabaseSitePagesRepository
│   ├── mappers.py                  # Conversion dict ↔ SitePage
│   └── __init__.py
├── postgres/
│   ├── site_pages_repository.py   # PostgresSitePagesRepository
│   ├── connection.py               # Pool asyncpg
│   └── __init__.py
├── memory/
│   ├── site_pages_repository.py   # InMemorySitePagesRepository
│   ├── mock_embedding_service.py  # MockEmbeddingService
│   └── __init__.py
└── openai/
    ├── embedding_service.py        # OpenAIEmbeddingService
    └── __init__.py
```

### Backends disponibles

#### 1. PostgreSQL (`postgres`)

**Production-ready** - Backend recommandé pour la production.

- Utilise `asyncpg` pour les performances async
- Extension `pgvector` pour la recherche vectorielle
- Support complet du cosine similarity
- Connection pooling intégré

**Configuration**:
```bash
REPOSITORY_TYPE=postgres
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=archon
POSTGRES_USER=postgres
POSTGRES_PASSWORD=secret
```

**Initialisation**:
```python
from archon.container import get_repository_async

repo = await get_repository_async()  # Async requis pour PostgreSQL
```

#### 2. Supabase (`supabase`)

**Legacy** - Backend historique, toujours supporté.

- Utilise le SDK Supabase (wraps PostgreSQL + pgvector)
- Utilise des RPC functions pour la recherche vectorielle
- Simplifie la configuration (URL + clé)

**Configuration**:
```bash
REPOSITORY_TYPE=supabase
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=eyJ...
```

**Initialisation**:
```python
from archon.container import get_repository

repo = get_repository()  # Sync OK pour Supabase
```

#### 3. Memory (`memory`)

**Tests uniquement** - Backend en mémoire pour les tests.

- Stockage dans un dict Python
- Cosine similarity simulé
- Pas de persistance
- Ultra-rapide

**Configuration**:
```python
from archon.container import configure, get_repository

configure(repository_type="memory")
repo = get_repository()
```

### Services d'embedding

#### OpenAI (`openai`)

Backend par défaut pour les embeddings.

```python
from archon.container import get_embedding_service

embedding_svc = get_embedding_service()
vector = await embedding_svc.get_embedding("query text")
```

#### Mock (`mock`)

Pour les tests - retourne des vecteurs aléatoires.

```python
from archon.container import configure, get_embedding_service

configure(embedding_type="mock")
embedding_svc = get_embedding_service()
```

---

## Guide d'utilisation

### Utilisation basique

```python
from archon.container import get_repository_async, get_embedding_service
from archon.domain import SitePage, SitePageMetadata

# 1. Récupérer les services
repo = await get_repository_async()
embedding_svc = get_embedding_service()

# 2. Créer une page
page = SitePage(
    url="https://example.com/docs",
    chunk_number=0,
    title="Documentation",
    content="Full text content...",
    metadata=SitePageMetadata(source="example_docs"),
)

# 3. Générer l'embedding
page.embedding = await embedding_svc.get_embedding(page.content)

# 4. Insérer dans la base
inserted = await repo.insert(page)
print(f"Inserted with ID: {inserted.id}")

# 5. Rechercher par similarité
query = "How to use the API?"
query_embedding = await embedding_svc.get_embedding(query)
results = await repo.search_similar(query_embedding, limit=5)

for result in results:
    print(f"{result.similarity:.2f} - {result.page.title}")
```

### Insertion batch (plus efficace)

```python
pages = []
for i in range(100):
    page = SitePage(
        url=f"https://example.com/page{i}",
        chunk_number=0,
        title=f"Page {i}",
        content=f"Content {i}...",
        metadata=SitePageMetadata(source="example_docs"),
    )
    page.embedding = await embedding_svc.get_embedding(page.content)
    pages.append(page)

# Insertion en batch (plus rapide)
inserted_pages = await repo.insert_batch(pages)
print(f"Inserted {len(inserted_pages)} pages")
```

### Récupération par URL

```python
# Récupérer tous les chunks d'une URL
url = "https://ai.pydantic.dev/agents/"
chunks = await repo.find_by_url(url)

print(f"Found {len(chunks)} chunks:")
for chunk in chunks:
    print(f"  - Chunk {chunk.chunk_number}: {chunk.title}")
```

### Suppression par source

```python
# Supprimer toutes les pages d'une source
deleted_count = await repo.delete_by_source("old_docs")
print(f"Deleted {deleted_count} pages")
```

### Comptage

```python
# Compter toutes les pages
total = await repo.count()

# Compter par source
pydantic_count = await repo.count({"metadata.source": "pydantic_ai_docs"})

print(f"Total: {total}, Pydantic AI: {pydantic_count}")
```

---

## Tests

### Tests avec InMemoryRepository

Le `InMemoryRepository` est parfait pour les tests car il:
- Ne nécessite aucune infrastructure
- Est ultra-rapide
- Peut être reset facilement

#### Exemple de test basique

```python
import pytest
from archon.container import configure, get_repository, reset
from archon.domain import SitePage, SitePageMetadata

@pytest.fixture
def setup_container():
    """Configure le container pour les tests."""
    reset()
    configure(repository_type="memory", embedding_type="mock")
    yield
    reset()

@pytest.mark.asyncio
async def test_insert_and_retrieve(setup_container):
    """Test insertion et récupération."""
    repo = get_repository()

    page = SitePage(
        url="https://example.com/test",
        chunk_number=0,
        title="Test Page",
        content="Test content",
        metadata=SitePageMetadata(source="test"),
        embedding=[0.1, 0.2, 0.3],
    )

    # Insert
    inserted = await repo.insert(page)
    assert inserted.id == 1

    # Retrieve
    retrieved = await repo.get_by_id(inserted.id)
    assert retrieved is not None
    assert retrieved.title == "Test Page"
```

#### Test de recherche vectorielle

```python
@pytest.mark.asyncio
async def test_vector_search(setup_container):
    """Test recherche par similarité."""
    repo = get_repository()

    # Insert plusieurs pages avec embeddings différents
    pages = [
        SitePage(
            url=f"https://example.com/page{i}",
            chunk_number=0,
            title=f"Page {i}",
            content=f"Content {i}",
            metadata=SitePageMetadata(source="test"),
            embedding=[i * 0.1, i * 0.2, i * 0.3],
        )
        for i in range(5)
    ]
    await repo.insert_batch(pages)

    # Recherche
    query_embedding = [0.2, 0.4, 0.6]  # Proche de page 2
    results = await repo.search_similar(query_embedding, limit=3)

    assert len(results) <= 3
    assert all(r.similarity >= 0 and r.similarity <= 1 for r in results)
    # Le plus similaire devrait être en premier
    assert results[0].similarity >= results[1].similarity
```

#### Test avec override

```python
from archon.container import override_repository
from archon.infrastructure.memory import InMemorySitePagesRepository

@pytest.mark.asyncio
async def test_with_custom_repo():
    """Test avec un repository custom."""
    custom_repo = InMemorySitePagesRepository()
    override_repository(custom_repo)

    # Le repository injecté sera custom_repo
    from archon.container import get_repository
    repo = get_repository()

    assert repo is custom_repo
```

### Tests d'intégration

Pour tester avec PostgreSQL:

```python
import pytest
from archon.container import configure, get_repository_async, reset

@pytest.mark.asyncio
@pytest.mark.integration  # Marquer comme test d'intégration
async def test_postgres_integration():
    """Test d'intégration avec PostgreSQL."""
    reset()
    configure(repository_type="postgres")

    repo = await get_repository_async()

    # Vérifier que le repository fonctionne
    count = await repo.count()
    assert count >= 0
```

Exécution:
```bash
# Tests unitaires uniquement (rapides)
pytest -v -m "not integration"

# Tous les tests (avec intégration)
pytest -v

# Tests d'intégration uniquement
pytest -v -m integration
```

---

## Ajouter un nouveau backend

Vous pouvez ajouter un nouveau backend (ex: MongoDB, Elasticsearch) en suivant ces étapes:

### 1. Créer l'implémentation

Créez `archon/infrastructure/mongodb/site_pages_repository.py`:

```python
from typing import Optional, List, Dict, Any
from archon.domain import ISitePagesRepository, SitePage, SearchResult

class MongoDBSitePagesRepository(ISitePagesRepository):
    """
    MongoDB implementation of ISitePagesRepository.

    Uses MongoDB Atlas Vector Search for similarity search.
    """

    def __init__(self, client, database: str, collection: str):
        """
        Initialize MongoDB repository.

        Args:
            client: MongoDB client (motor.motor_asyncio.AsyncIOMotorClient)
            database: Database name
            collection: Collection name
        """
        self._client = client
        self._db = self._client[database]
        self._collection = self._db[collection]

    async def get_by_id(self, id: int) -> Optional[SitePage]:
        """Get page by ID."""
        doc = await self._collection.find_one({"_id": id})
        if not doc:
            return None
        return self._doc_to_page(doc)

    async def find_by_url(self, url: str) -> List[SitePage]:
        """Find all chunks for a URL."""
        cursor = self._collection.find({"url": url}).sort("chunk_number", 1)
        docs = await cursor.to_list(length=None)
        return [self._doc_to_page(doc) for doc in docs]

    async def search_similar(
        self,
        embedding: List[float],
        limit: int = 5,
        filter: Optional[Dict[str, Any]] = None,
    ) -> List[SearchResult]:
        """
        Search using MongoDB Atlas Vector Search.

        Requires a vector search index on the 'embedding' field.
        """
        pipeline = [
            {
                "$vectorSearch": {
                    "queryVector": embedding,
                    "path": "embedding",
                    "numCandidates": limit * 10,
                    "limit": limit,
                    "index": "vector_index",  # Nom de l'index vectoriel
                }
            },
            {
                "$addFields": {
                    "similarity": {"$meta": "vectorSearchScore"}
                }
            }
        ]

        # Ajouter le filtre si fourni
        if filter:
            pipeline.insert(1, {"$match": filter})

        cursor = self._collection.aggregate(pipeline)
        docs = await cursor.to_list(length=limit)

        results = []
        for doc in docs:
            page = self._doc_to_page(doc)
            similarity = doc.get("similarity", 0.0)
            results.append(SearchResult(page=page, similarity=similarity))

        return results

    async def list_unique_urls(self, source: Optional[str] = None) -> List[str]:
        """List unique URLs."""
        match_stage = {}
        if source:
            match_stage = {"metadata.source": source}

        pipeline = [
            {"$match": match_stage},
            {"$group": {"_id": "$url"}},
            {"$sort": {"_id": 1}}
        ]

        cursor = self._collection.aggregate(pipeline)
        docs = await cursor.to_list(length=None)
        return [doc["_id"] for doc in docs]

    async def insert(self, page: SitePage) -> SitePage:
        """Insert a new page."""
        if page.id is not None:
            raise ValueError("Cannot insert a page with an existing id")

        # Générer un nouvel ID
        next_id = await self._get_next_id()
        doc = self._page_to_doc(page)
        doc["_id"] = next_id

        await self._collection.insert_one(doc)

        page.id = next_id
        return page

    async def insert_batch(self, pages: List[SitePage]) -> List[SitePage]:
        """Insert multiple pages."""
        if any(p.id is not None for p in pages):
            raise ValueError("Cannot insert pages with existing ids")

        # Générer les IDs
        start_id = await self._get_next_id()
        docs = []
        for i, page in enumerate(pages):
            doc = self._page_to_doc(page)
            doc["_id"] = start_id + i
            page.id = start_id + i
            docs.append(doc)

        if docs:
            await self._collection.insert_many(docs)

        return pages

    async def delete_by_source(self, source: str) -> int:
        """Delete all pages from a source."""
        result = await self._collection.delete_many({"metadata.source": source})
        return result.deleted_count

    async def count(self, filter: Optional[Dict[str, Any]] = None) -> int:
        """Count pages."""
        query = filter or {}
        return await self._collection.count_documents(query)

    # Helpers

    async def _get_next_id(self) -> int:
        """Get next sequential ID."""
        # Utiliser une collection "counters" pour les IDs auto-incrémentés
        counters = self._db["counters"]
        result = await counters.find_one_and_update(
            {"_id": "site_pages"},
            {"$inc": {"seq": 1}},
            upsert=True,
            return_document=True
        )
        return result["seq"]

    def _doc_to_page(self, doc: dict) -> SitePage:
        """Convert MongoDB document to SitePage."""
        return SitePage(
            id=doc["_id"],
            url=doc["url"],
            chunk_number=doc["chunk_number"],
            title=doc.get("title"),
            summary=doc.get("summary"),
            content=doc.get("content"),
            metadata=doc["metadata"],
            embedding=doc.get("embedding"),
            created_at=doc.get("created_at"),
        )

    def _page_to_doc(self, page: SitePage) -> dict:
        """Convert SitePage to MongoDB document."""
        doc = page.model_dump(exclude={"id"})
        if page.id is not None:
            doc["_id"] = page.id
        return doc
```

### 2. Ajouter au container

Modifiez `archon/container.py`:

```python
def get_repository() -> ISitePagesRepository:
    """Retourne l'instance du repository configure."""
    global _repository_instance

    if _repository_instance is None:
        repo_type = _config["repository_type"]
        if repo_type is None:
            repo_type = os.environ.get("REPOSITORY_TYPE", "supabase")

        # ... code existant ...

        elif repo_type == "mongodb":
            from motor.motor_asyncio import AsyncIOMotorClient
            from archon.infrastructure.mongodb import MongoDBSitePagesRepository

            mongo_uri = os.environ.get("MONGODB_URI", "mongodb://localhost:27017")
            database = os.environ.get("MONGODB_DATABASE", "archon")
            collection = os.environ.get("MONGODB_COLLECTION", "site_pages")

            client = AsyncIOMotorClient(mongo_uri)
            _repository_instance = MongoDBSitePagesRepository(client, database, collection)
            logger.info(f"Created MongoDBSitePagesRepository instance ({database}.{collection})")

        else:
            raise ValueError(f"Unknown repository type: {repo_type}")

    return _repository_instance
```

### 3. Configurer l'environnement

```bash
REPOSITORY_TYPE=mongodb
MONGODB_URI=mongodb://localhost:27017
MONGODB_DATABASE=archon
MONGODB_COLLECTION=site_pages
```

### 4. Créer les tests

Créez `tests/infrastructure/test_mongodb_repository.py`:

```python
import pytest
from archon.infrastructure.mongodb import MongoDBSitePagesRepository
from archon.domain import SitePage, SitePageMetadata

@pytest.mark.asyncio
@pytest.mark.integration
async def test_mongodb_repository():
    """Test MongoDB repository implementation."""
    from motor.motor_asyncio import AsyncIOMotorClient

    client = AsyncIOMotorClient("mongodb://localhost:27017")
    repo = MongoDBSitePagesRepository(client, "archon_test", "site_pages")

    # Cleanup
    await repo._collection.delete_many({})

    # Test insert
    page = SitePage(
        url="https://example.com/test",
        chunk_number=0,
        title="Test",
        content="Content",
        metadata=SitePageMetadata(source="test"),
        embedding=[0.1, 0.2, 0.3],
    )

    inserted = await repo.insert(page)
    assert inserted.id is not None

    # Test retrieve
    retrieved = await repo.get_by_id(inserted.id)
    assert retrieved.title == "Test"

    # Cleanup
    await repo._collection.delete_many({})
```

### 5. Documentation

Mettez à jour cette documentation avec votre nouveau backend!

---

## Diagramme de séquence

Exemple d'un workflow complet:

```
User                 Container              Repository            Database
 │                       │                      │                     │
 │ get_repository_async()│                      │                     │
 ├──────────────────────>│                      │                     │
 │                       │ PostgresSitePagesRepository.create()       │
 │                       ├─────────────────────>│                     │
 │                       │                      │ CREATE POOL         │
 │                       │                      ├────────────────────>│
 │                       │                      │<────────────────────┤
 │                       │<─────────────────────┤                     │
 │<──────────────────────┤                      │                     │
 │                       │                      │                     │
 │ search_similar(embed) │                      │                     │
 ├──────────────────────────────────────────────>                     │
 │                       │                      │ SELECT ... ORDER BY │
 │                       │                      │   embedding <=> ... │
 │                       │                      ├────────────────────>│
 │                       │                      │<────────────────────┤
 │<──────────────────────────────────────────────┤                     │
 │                       │                      │                     │
```

---

## Ressources

- **Code source**: `archon/domain/`, `archon/infrastructure/`, `archon/container.py`
- **Tests**: `tests/domain/`, `tests/infrastructure/`, `tests/test_container.py`
- **Migration guide**: `docs/MIGRATION_MANIFEST.md`
- **Performance benchmarks**: `tests/performance/test_benchmark.py`

---

## FAQ

### Quelle différence entre Supabase et PostgreSQL direct?

- **Supabase**: SDK Python qui wraps PostgreSQL + pgvector. Plus simple à configurer (URL + clé), mais ajoute une couche d'abstraction.
- **PostgreSQL direct**: Utilise `asyncpg` pour parler directement à PostgreSQL. Plus performant, plus de contrôle, mais nécessite la gestion du pool de connexions.

### Dois-je utiliser `get_repository()` ou `get_repository_async()`?

- **`get_repository()`**: Pour backends synchrones (Supabase, Memory)
- **`get_repository_async()`**: Pour backends async (PostgreSQL direct)

Si vous utilisez PostgreSQL, utilisez **toujours** `get_repository_async()`.

### Comment changer de backend sans modifier mon code?

C'est tout l'intérêt du pattern Repository! Il suffit de:

1. Changer la variable d'environnement `REPOSITORY_TYPE`
2. Fournir les credentials du nouveau backend

Votre code métier ne change pas car il dépend de l'interface `ISitePagesRepository`, pas de l'implémentation.

### Puis-je utiliser plusieurs backends en même temps?

Pas directement, mais vous pouvez:

1. Créer plusieurs instances manuellement:
   ```python
   from archon.infrastructure.postgres import PostgresSitePagesRepository
   from archon.infrastructure.supabase import SupabaseSitePagesRepository

   postgres_repo = await PostgresSitePagesRepository.create(...)
   supabase_repo = SupabaseSitePagesRepository(supabase_client)
   ```

2. Implémenter un `CompositeRepository` qui délègue aux deux

### Comment migrer de Supabase vers PostgreSQL?

Voir le guide complet dans `docs/MIGRATION_POSTGRES.md`.

### Où trouver des exemples de code?

- **Tests**: `tests/infrastructure/test_memory_repository.py` (le plus simple)
- **Crawlers**: `crawl_pydantic_ai_docs.py` (exemple réel)
- **Services**: `archon/services/documentation_service.py`

---

**Date**: 2025-12-29
**Version**: 1.0
**Auteur**: Archon AI
