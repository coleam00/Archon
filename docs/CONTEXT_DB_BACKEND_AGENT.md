# Contexte pour db-backend-agent

**Date de création:** 2025-11-30
**Projet parent:** Refactorisation Database Layer Archon
**Branche Git:** `refactor/db-layer`

---

## Résumé Exécutif

Le projet de refactorisation DB Layer est **100% complété** (Phases 1-4). Nous avons maintenant une architecture propre basée sur le Repository Pattern qui permet d'ajouter facilement de nouveaux backends de base de données.

**Mission de cet agent:** Créer des implémentations alternatives du `ISitePagesRepository` pour :
1. PostgreSQL direct (sans Supabase) avec asyncpg + pgvector
2. SQLAlchemy pour portabilité multi-DB
3. SQLite pour développement local

---

## État du Projet Parent (Refactorisation DB)

### Phases Complétées ✅

| Phase | Description | Statut |
|-------|-------------|--------|
| Phase 1 | Domain Layer (models, interfaces) | ✅ 100% |
| Phase 2 | Infrastructure Layer (repositories) | ✅ 100% |
| Phase 3 | Migration des consommateurs | ✅ 100% |
| Phase 4 | Nettoyage et validation | ✅ 100% |

**Tests:** 135 tests passent (121 exécutés + 29 skipped pour intégration Supabase)

### Commit de référence
- Phase 1-2: `80e3c47`
- Phase 3 agents: `60f5b6d`
- Bug fix pydantic-ai: `7baddad`

---

## Architecture Actuelle

### Structure des Fichiers Clés

```
archon/
├── domain/                          # ✅ COMPLET
│   ├── __init__.py
│   ├── models/
│   │   ├── site_page.py            # SitePage, SitePageMetadata
│   │   └── search_result.py        # SearchResult
│   └── interfaces/
│       ├── site_pages_repository.py # ISitePagesRepository (8 méthodes)
│       └── embedding_service.py     # IEmbeddingService (2 méthodes)
│
├── infrastructure/                  # ✅ COMPLET (à étendre)
│   ├── __init__.py
│   ├── supabase/                   # ✅ Implémentation existante
│   │   ├── site_pages_repository.py
│   │   └── mappers.py
│   ├── memory/                     # ✅ Pour tests
│   │   ├── site_pages_repository.py
│   │   └── mock_embedding_service.py
│   ├── openai/                     # ✅ Service embeddings
│   │   └── embedding_service.py
│   │
│   ├── postgres/                   # 🆕 À CRÉER
│   ├── sqlalchemy/                 # 🆕 À CRÉER
│   └── sqlite/                     # 🆕 À CRÉER
│
├── container.py                    # ✅ DI Container (à étendre)
└── services/
    └── documentation_service.py    # ✅ Services métier
```

### Interface ISitePagesRepository (8 méthodes)

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

### Modèles Domain

```python
# SitePageMetadata
class SitePageMetadata(BaseModel):
    source: str  # Ex: "pydantic_ai_docs"
    chunk_size: Optional[int] = None
    crawled_at: Optional[datetime] = None
    url_path: Optional[str] = None
    model_config = {"extra": "allow"}

# SitePage
class SitePage(BaseModel):
    id: Optional[int] = None
    url: str
    chunk_number: int = 0
    title: Optional[str] = None
    summary: Optional[str] = None
    content: Optional[str] = None
    metadata: SitePageMetadata
    embedding: Optional[List[float]] = None
    created_at: Optional[datetime] = None

# SearchResult
class SearchResult(BaseModel):
    page: SitePage
    similarity: float  # Score 0-1
```

---

## Tâches à Réaliser

### Backend 1: PostgreSQL Direct (Priorité HAUTE)

**Objectif:** Remplacer Supabase par une connexion PostgreSQL directe avec asyncpg.

**Fichiers à créer:**
```
archon/infrastructure/postgres/
├── __init__.py
├── site_pages_repository.py    # PostgresSitePagesRepository
└── connection.py               # Pool de connexions asyncpg

tests/infrastructure/
└── test_postgres_repository.py
```

**Dépendances à ajouter:**
```
asyncpg>=0.29.0
pgvector>=0.2.0
```

**Schema SQL requis:**
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

**Variables d'environnement:**
```env
REPOSITORY_TYPE=postgres
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=archon
POSTGRES_USER=postgres
POSTGRES_PASSWORD=secret
```

### Backend 2: SQLAlchemy (Priorité MOYENNE)

**Objectif:** Portabilité multi-DB (PostgreSQL, SQLite, MySQL).

**Fichiers à créer:**
```
archon/infrastructure/sqlalchemy/
├── __init__.py
├── site_pages_repository.py    # SQLAlchemySitePagesRepository
├── models.py                   # Modèles ORM
└── connection.py               # Engine et sessions

tests/infrastructure/
└── test_sqlalchemy_repository.py
```

**Dépendances:**
```
sqlalchemy[asyncio]>=2.0.0
asyncpg>=0.29.0      # PostgreSQL
aiosqlite>=0.19.0    # SQLite
pgvector>=0.2.0      # Vectors PostgreSQL
```

### Backend 3: SQLite (Priorité BASSE)

**Objectif:** Développement local sans infrastructure.

**Limitation:** Recherche vectorielle limitée (calcul Python ou sqlite-vss).

---

## Fichiers de Référence à Lire

1. **Interface:** `archon/domain/interfaces/site_pages_repository.py`
2. **Implémentation Supabase:** `archon/infrastructure/supabase/site_pages_repository.py`
3. **Implémentation Memory:** `archon/infrastructure/memory/site_pages_repository.py`
4. **Mappers:** `archon/infrastructure/supabase/mappers.py`
5. **Container DI:** `archon/container.py`
6. **Tests existants:** `tests/infrastructure/test_memory_repository.py`

---

## Pattern d'Implémentation

### Structure d'une nouvelle implémentation

```python
"""
{Backend} implementation of the ISitePagesRepository interface.
"""

import logging
from typing import Optional, List, Dict, Any
from archon.domain.interfaces.site_pages_repository import ISitePagesRepository
from archon.domain.models.site_page import SitePage, SitePageMetadata
from archon.domain.models.search_result import SearchResult

logger = logging.getLogger("archon.repository.{backend}")


class {Backend}SitePagesRepository(ISitePagesRepository):
    """
    {Backend} implementation of the site pages repository.
    """

    def __init__(self, connection):
        self.connection = connection
        self.table_name = "site_pages"

    # Implémenter les 8 méthodes...
```

### Intégration dans container.py

Après création, ajouter dans `archon/container.py`:

```python
elif repo_type == "postgres":
    from archon.infrastructure.postgres import PostgresSitePagesRepository
    # ... configuration et création
```

---

## Commandes Utiles

```bash
# Vérifier que les tests existants passent toujours
pytest tests/ -v --tb=short

# Tester uniquement l'infrastructure
pytest tests/infrastructure/ -v

# Tester un backend spécifique
pytest tests/infrastructure/test_postgres_repository.py -v

# Vérifier les imports
python -c "from archon.domain import ISitePagesRepository, SitePage; print('OK')"
python -c "from archon.container import get_repository; print('OK')"
```

---

## Notes Importantes

### Bug Fix Pydantic-AI (déjà appliqué)

Un bug a été corrigé le 2025-11-30 concernant l'API pydantic-ai:
- **Ancien:** `OpenAIModel(model, base_url=..., api_key=...)`
- **Nouveau:** `OpenAIModel(model, provider=OpenAIProvider(base_url=..., api_key=...))`

Voir `docs/BUG_REPORT_PYDANTIC_AI_API.md` pour détails.

### Archon MCP Server

Le serveur Archon MCP est actuellement **DOWN**. Les tâches ne peuvent pas être trackées via les outils MCP. Utiliser ce document et les commits Git pour le suivi.

### Contraintes

1. **Toutes les méthodes async** - Pas de code synchrone
2. **Tests obligatoires** - Chaque backend doit avoir sa suite de tests
3. **Logging cohérent** - Utiliser `logging.getLogger("archon.repository.{backend}")`
4. **Backward compatible** - Ne pas casser les implémentations existantes

---

## Checklist de Validation

Pour chaque nouveau backend:

- [ ] Fichier `__init__.py` créé avec exports
- [ ] Classe Repository implémentant `ISitePagesRepository`
- [ ] Les 8 méthodes implémentées
- [ ] Logging ajouté sur chaque méthode
- [ ] Tests unitaires créés
- [ ] Tous les tests passent
- [ ] Intégration dans `container.py`
- [ ] Variables d'environnement documentées
- [ ] Commit avec message descriptif

---

## Historique des Sessions

| Date | Action | Commit |
|------|--------|--------|
| 2025-11-29 | Phase 1-2 complétées | `80e3c47` |
| 2025-11-30 | Phase 3-4 complétées | `60f5b6d` |
| 2025-11-30 | Fix pydantic-ai API | `7baddad` |
| 2025-11-30 | Création agent db-backend | - |

---

*Document généré le 2025-11-30 pour le projet db-backend-agent*
