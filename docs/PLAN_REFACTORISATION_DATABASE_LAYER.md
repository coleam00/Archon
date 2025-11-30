# Plan de Refactorisation - Database Layer Archon

**Version:** 1.0
**Date:** 2025-01-29
**Auteur:** Claude Database Layer Analyst
**Statut:** Draft
**Tags:** database, refactoring, architecture, supabase, repository-pattern

---

## Resume Executif

L'analyse du codebase Archon revele un couplage fort avec Supabase, reparti sur 8 fichiers principaux avec 25+ points de contact directs. L'absence totale de couche d'abstraction (Repository Pattern) rend le code difficile a tester et a maintenir. La migration vers une architecture propre est realisable en 5 phases incrementales sur environ 4-6 semaines, sans interruption de service.

**Gains attendus:**
- Testabilite amelioree
- Flexibilite du backend de stockage
- Meilleure separation des responsabilites

---

## 1. Audit du Code Existant

### 1.1 Fichiers de la Couche Database

| Fichier | Role | Couplage | Usages Supabase |
|---------|------|----------|-----------------|
| `utils/utils.py` | Configuration et Factory des clients | MODERATE | `Client`, `create_client` |
| `archon/agent_tools.py` | Outils de requetes RAG | TIGHT | `supabase.rpc()`, `supabase.from_().select()` |
| `archon/crawl_pydantic_ai_docs.py` | Crawler et stockage des embeddings | TIGHT | `supabase.table().insert()`, `.delete()` |
| `streamlit_pages/database.py` | Interface UI pour la gestion de la DB | TIGHT | `supabase.table().select()`, `.delete()` |
| `streamlit_pages/documentation.py` | Interface UI pour la documentation | MODERATE | `supabase_client.table().select()` |
| `archon/archon_graph.py` | Orchestration du workflow LangGraph | MODERATE | Injection du client en dependance |
| `archon/pydantic_ai_coder.py` | Agent principal de codage | MODERATE | Type `Client` dans dataclass |
| `archon/refiner_agents/*.py` | Agents de refinement (3 fichiers) | MODERATE | Type `Client` dans dataclass |

### 1.2 Schema de Base de Donnees

**Table:** `site_pages`

| Colonne | Type | Role |
|---------|------|------|
| `id` | bigserial | Primary Key |
| `url` | varchar | URL source |
| `chunk_number` | integer | Ordre du chunk |
| `title` | varchar | Titre extrait |
| `summary` | varchar | Resume genere par LLM |
| `content` | text | Contenu textuel |
| `metadata` | jsonb | Metadonnees flexibles |
| `embedding` | vector(1536) | Vecteur OpenAI |
| `created_at` | timestamptz | Date creation |

**Contraintes:**
- `UNIQUE(url, chunk_number)`

**Index:**
- ivfflat on embedding (recherche vectorielle)
- GIN on metadata (filtrage JSONB)

**Fonctions RPC:**
- `match_site_pages(query_embedding, match_count, filter)`

### 1.3 Patterns Actuellement Utilises

**Patterns presents (partiels):**
- Factory Pattern (partiel) - `utils/utils.py::get_clients()`
- Dependency Injection (partiel) - Les agents recoivent supabase via deps

**Patterns absents:**

| Pattern | Impact |
|---------|--------|
| Repository Pattern | HIGH - Pas d'abstraction entre logique metier et requetes |
| Unit of Work | MEDIUM - Pas de gestion transactionnelle explicite |
| Interface Segregation | HIGH - Le client Supabase complet est injecte |
| Domain Models | MEDIUM - Les donnees sont des dictionnaires bruts |

---

## 2. Identification des Problemes

### 2.1 Couplage Fort avec Supabase (Severite: HIGH)

| ID | Probleme | Impact |
|----|----------|--------|
| P1 | Import direct du type `Client` dans 6+ fichiers | Impossible de changer de backend |
| P2 | Appels API Supabase dans le code metier | Syntaxe PostgREST dispersee |
| P3 | Dependance aux fonctionnalites Supabase (RLS, rpc) | Migration difficile |

**Exemple de code problematique:**
```python
# agent_tools.py
supabase.rpc('match_site_pages', {...}).execute()
```

### 2.2 Absence de Couche d'Abstraction (Severite: HIGH)

| ID | Probleme | Impact |
|----|----------|--------|
| P4 | Pas de Repository Pattern | Duplication de logique, difficile a tester |
| P5 | Pas de Domain Models | Pas de validation, erreurs a l'execution |
| P6 | Pas d'interfaces mockables | Tests d'integration obligatoires |

### 2.3 Dette Technique (Severite: MEDIUM)

| ID | Probleme | Description |
|----|----------|-------------|
| P7 | Duplication de code | Les memes requetes select() sont repetees |
| P8 | Gestion d'erreurs inconsistante | `return []` vs `return "Error..."` |
| P9 | Absence totale de tests | 0 fichiers de test trouves |
| P10 | Dimension vectorielle hardcodee | Valeur 1536 en dur |

### 2.4 Problemes de Testabilite (Severite: CRITICAL)

- Dependances non mockables (client cree au niveau module)
- Pas d'injection de dependances complete
- Pas de fixtures de test
- Couplage UI-Database direct

---

## 3. Proposition d'Architecture Cible

### 3.1 Structure de Fichiers Proposee

```
archon/
  domain/
    models/
      __init__.py
      site_page.py          # Dataclass/Pydantic model pour SitePage
      embedding.py          # Model pour les embeddings
      search_result.py      # Model pour les resultats de recherche
    interfaces/
      __init__.py
      base_repository.py    # Interface abstraite de base
      site_pages_repository.py  # Interface specifique
      embedding_service.py  # Interface pour le service d'embedding
  infrastructure/
    supabase/
      __init__.py
      client.py             # Configuration Supabase
      site_pages_repository.py  # Implementation Supabase
      mappers.py            # Mapping dict <-> domain models
    memory/
      __init__.py
      site_pages_repository.py  # Implementation in-memory pour tests
  services/
    __init__.py
    documentation_service.py  # Logique metier pure
    crawl_service.py          # Service de crawling
  container.py             # Dependency Injection container
```

### 3.2 Interfaces a Creer

#### ISitePagesRepository

```python
from abc import ABC, abstractmethod
from typing import Optional, List

class ISitePagesRepository(ABC):
    @abstractmethod
    async def get_by_id(self, id: int) -> Optional[SitePage]: ...

    @abstractmethod
    async def find_by_url(self, url: str) -> List[SitePage]: ...

    @abstractmethod
    async def search_similar(self, embedding: List[float], limit: int, filter: dict) -> List[SearchResult]: ...

    @abstractmethod
    async def list_unique_urls(self, source: str) -> List[str]: ...

    @abstractmethod
    async def insert(self, page: SitePage) -> SitePage: ...

    @abstractmethod
    async def insert_batch(self, pages: List[SitePage]) -> List[SitePage]: ...

    @abstractmethod
    async def delete_by_source(self, source: str) -> int: ...

    @abstractmethod
    async def count(self, filter: Optional[dict] = None) -> int: ...
```

#### IEmbeddingService

```python
class IEmbeddingService(ABC):
    @abstractmethod
    async def get_embedding(self, text: str) -> List[float]: ...

    @abstractmethod
    async def get_embeddings_batch(self, texts: List[str]) -> List[List[float]]: ...
```

### 3.3 Domain Models Proposes

```python
from pydantic import BaseModel
from datetime import datetime
from typing import Optional, List

class SitePageMetadata(BaseModel):
    source: str
    chunk_size: int
    crawled_at: datetime
    url_path: str

class SitePage(BaseModel):
    id: Optional[int] = None
    url: str
    chunk_number: int
    title: str
    summary: str
    content: str
    metadata: SitePageMetadata
    embedding: Optional[List[float]] = None
    created_at: Optional[datetime] = None

class SearchResult(BaseModel):
    page: SitePage
    similarity: float
```

### 3.4 Diagrammes d'Architecture

#### Architecture Actuelle (Avant)

```
[Streamlit UI] --> [Pydantic AI Agents] --> [agent_tools.py] --> [SUPABASE]
                                        --> [database.py] -----> [SUPABASE]
                                        --> [documentation.py] -> [SUPABASE]
[crawl_pydantic_ai_docs.py] ---------------------------------> [SUPABASE]
```

#### Architecture Cible (Apres)

```
[Streamlit UI] --> [DI Container] --> [DocumentationService] --> [ISitePagesRepository]
[Agents]       --> [DI Container] --> [CrawlService]         --> [IEmbeddingService]

[ISitePagesRepository] --> [SupabaseSitePagesRepository] --> [SUPABASE]
                       --> [InMemorySitePagesRepository] --> [Tests]
```

### 3.5 Strategie de Decouplage (Strangler Fig Pattern)

1. Creer la couche Domain (sans modifier le code existant)
2. Implementer le Repository Supabase (wrapper le code existant)
3. Creer le Container DI
4. Migrer les consommateurs un par un
5. Supprimer l'ancien code

---

## 4. Plan de Migration Incrementale

### Phase 0: Preparation (2-3 jours)

| ID | Tache | Complexite | Risque | Assignee |
|----|-------|------------|--------|----------|
| T0.1 | Mettre en place l'infrastructure de tests | M | LOW | Coding Agent |
| T0.2 | Ecrire les tests de caracterisation | L | LOW | Coding Agent |
| T0.3 | Documenter le schema actuel | S | LOW | User |

### Phase 1: Creation de la couche Domain (3-4 jours)

| ID | Tache | Complexite | Risque | Assignee |
|----|-------|------------|--------|----------|
| T1.1 | Creer les modeles Pydantic (SitePage, etc.) | M | LOW | Coding Agent |
| T1.2 | Definir l'interface ISitePagesRepository | M | LOW | Coding Agent |
| T1.3 | Definir l'interface IEmbeddingService | S | LOW | Coding Agent |
| T1.4 | Creer les tests unitaires pour les modeles | S | LOW | Coding Agent |

### Phase 2: Implementation du Repository Supabase (4-5 jours)

| ID | Tache | Complexite | Risque | Assignee |
|----|-------|------------|--------|----------|
| T2.1 | Creer les mappers dict <-> domain | M | LOW | Coding Agent |
| T2.2 | Implementer SupabaseSitePagesRepository | L | MEDIUM | Coding Agent |
| T2.3 | Implementer InMemorySitePagesRepository | M | LOW | Coding Agent |
| T2.4 | Implementer OpenAIEmbeddingService | S | LOW | Coding Agent |
| T2.5 | Tests d'integration pour le Repository | M | MEDIUM | Coding Agent |

### Phase 3: Migration des consommateurs (5-7 jours)

| ID | Tache | Complexite | Risque | Assignee |
|----|-------|------------|--------|----------|
| T3.1 | Configurer le container DI | M | LOW | Coding Agent |
| T3.2 | Migrer agent_tools.py | M | MEDIUM | Coding Agent |
| T3.3 | Migrer crawl_pydantic_ai_docs.py | L | MEDIUM | Coding Agent |
| T3.4 | Migrer streamlit_pages/database.py | M | LOW | Coding Agent |
| T3.5 | Migrer streamlit_pages/documentation.py | S | LOW | Coding Agent |
| T3.6 | Migrer les agents (pydantic_ai_coder, refiners) | L | MEDIUM | Coding Agent |
| T3.7 | Mettre a jour archon_graph.py | M | MEDIUM | Coding Agent |

### Phase 4: Nettoyage et Validation (2-3 jours)

| ID | Tache | Complexite | Risque | Assignee |
|----|-------|------------|--------|----------|
| T4.1 | Supprimer les imports Supabase obsoletes | S | LOW | Coding Agent |
| T4.2 | Executer la suite de tests complete | S | LOW | Coding Agent |
| T4.3 | Tests de performance | M | LOW | User |
| T4.4 | Mettre a jour la documentation | M | LOW | User |
| T4.5 | Revue de code finale | M | LOW | User |

---

## 5. Criteres de Succes

### Decouplage

- [ ] Zero import `from supabase import` dans archon/*.py (hors infrastructure/)
- [ ] Tous les agents utilisent des interfaces abstraites
- [ ] Le client Supabase n'est instancie qu'a un seul endroit

### Testabilite

- [ ] Couverture de tests > 70%
- [ ] Tests unitaires executables sans connexion DB
- [ ] Temps d'execution des tests < 30 secondes

### Maintenabilite

- [ ] Complexite cyclomatique < 10 par fonction
- [ ] Pas de duplication de code > 5 lignes
- [ ] Documentation des interfaces complete

### Fonctionnel

- [ ] Tous les tests de caracterisation passent
- [ ] Performance equivalente (+/- 10%)
- [ ] Aucune regression fonctionnelle

---

## 6. Quick Wins (Ameliorations Immediates)

| ID | Action | Effort | Fichiers |
|----|--------|--------|----------|
| QW1 | Centraliser la dimension vectorielle en constante | 1h | utils.py, site_pages.sql |
| QW2 | Extraire ProcessedChunk comme modele Pydantic | 30min | crawl_pydantic_ai_docs.py |
| QW3 | Standardiser la gestion d'erreurs | 2h | agent_tools.py |
| QW4 | Ajouter des type hints manquants | 2h | agent_tools.py, database.py |
| QW5 | Creer pytest.ini et un premier test | 30min | pytest.ini, tests/ |

---

## 7. Registre de Dette Technique (Hors Scope)

| ID | Probleme | Recommendation |
|----|----------|----------------|
| TD1 | Code duplique entre iterations/ | Archiver anciennes versions |
| TD2 | Gestion des variables d'environnement | Migrer vers pydantic-settings |
| TD3 | Absence de logging structure | Migrer vers structlog |
| TD4 | MCP Server couplage HTTP | Refactoriser apres DB |
| TD5 | Authentication Supabase non utilisee | Clarifier la strategie |

---

## Annexe: Inventaire Complet des Usages Supabase

| Fichier | Ligne | Type d'Usage | Couplage | Module Cible |
|---------|-------|--------------|----------|--------------|
| utils/utils.py | 1 | Import Client, create_client | MODERATE | infrastructure.supabase.client |
| utils/utils.py | 398-409 | get_clients() - Factory | MODERATE | container.py |
| agent_tools.py | 24 | Import Client | TIGHT | domain.interfaces |
| agent_tools.py | 30-37 | supabase.rpc('match_site_pages') | TIGHT | infrastructure.supabase.repository |
| agent_tools.py | 70-73 | supabase.from_().select().eq() | TIGHT | infrastructure.supabase.repository |
| agent_tools.py | 99-104 | supabase.from_().select().order() | TIGHT | infrastructure.supabase.repository |
| crawl_pydantic_ai_docs.py | 28 | get_clients() - Module level | TIGHT | services.crawl_service |
| crawl_pydantic_ai_docs.py | 261 | supabase.table().insert() | TIGHT | infrastructure.supabase.repository |
| crawl_pydantic_ai_docs.py | 426 | supabase.table().delete() | TIGHT | infrastructure.supabase.repository |
| database.py | 100 | supabase.table().select().limit() | TIGHT | services.documentation_service |
| database.py | 104 | supabase.table().select(count='exact') | TIGHT | services.documentation_service |
| database.py | 166 | supabase.table().delete().neq() | TIGHT | infrastructure.supabase.repository |
| documentation.py | 140 | supabase.table().select(count='exact') | MODERATE | services.documentation_service |
| documentation.py | 149 | supabase.table().select().limit() | MODERATE | services.documentation_service |
| archon_graph.py | 11 | Import Client | MODERATE | A supprimer |
| archon_graph.py | 67 | get_clients() | MODERATE | container.py |
| pydantic_ai_coder.py | 17 | Import Client | MODERATE | domain.interfaces |
| pydantic_ai_coder.py | 42 | supabase: Client dans dataclass | MODERATE | domain.interfaces |
| tools_refiner_agent.py | 17 | Import Client | MODERATE | domain.interfaces |
| tools_refiner_agent.py | 44 | supabase: Client dans dataclass | MODERATE | domain.interfaces |
| agent_refiner_agent.py | 17 | Import Client | MODERATE | domain.interfaces |
| agent_refiner_agent.py | 44 | supabase: Client dans dataclass | MODERATE | domain.interfaces |

---

*Document genere par l'agent db-layer-refactoring-analyst*
