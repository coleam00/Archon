# Migration Manifest - Database Layer Refactoring

**Version:** 1.1
**Date:** 2025-11-29
**Derniere mise a jour:** 2025-11-29 (Audit de completude)
**Projet:** Refactorisation Database Layer Archon
**Methode de verification:** Tests automatises

---

## Legende

| Statut | Signification |
|--------|---------------|
| `[ ]` | TODO - A faire |
| `[~]` | IN PROGRESS - En cours |
| `[x]` | DONE - Code modifie |
| `[v]` | VERIFIED - Test passe |

---

## Progression Globale

| Phase | Blocs | TODO | DONE | VERIFIED |
|-------|-------|------|------|----------|
| Phase 0 - Preparation | 3 | 3 | 0 | 0 |
| Phase 1 - Domain Layer | 6 | 6 | 0 | 0 |
| Phase 2 - Infrastructure | 6 | 6 | 0 | 0 |
| Phase 3 - Migration | 15 | 15 | 0 | 0 |
| Phase 4 - Nettoyage | 4 | 4 | 0 | 0 |
| **TOTAL** | **34** | **34** | **0** | **0** |

**Pourcentage complete:** 0%

---

## Phase 0 - Preparation

### P0-01: Infrastructure de tests
- **Statut:** `[ ]` TODO
- **Fichiers a creer:**
  - `pytest.ini`
  - `tests/__init__.py`
  - `tests/conftest.py`
- **Test de verification:** `pytest --collect-only` retourne sans erreur
- **Responsable:** Coding Agent

### P0-02: Tests de caracterisation
- **Statut:** `[ ]` TODO
- **Fichiers a creer:**
  - `tests/characterization/test_agent_tools.py`
  - `tests/characterization/test_crawl.py`
  - `tests/characterization/test_database_page.py`
  - `tests/characterization/test_documentation_page.py`
  - `tests/characterization/test_archon_graph.py`
  - `tests/characterization/test_pydantic_ai_coder.py`
  - `tests/characterization/test_advisor_agent.py`
  - `tests/characterization/test_tools_refiner.py`
  - `tests/characterization/test_agent_refiner.py`
  - `tests/characterization/test_prompt_refiner.py`
- **Test de verification:** `pytest tests/characterization/ -v` passe
- **Responsable:** Coding Agent
- **Note:** Ces tests capturent le comportement AVANT refactorisation

### P0-03: Documentation schema actuel
- **Statut:** `[ ]` TODO
- **Fichiers a creer:**
  - `docs/SCHEMA_ACTUEL.md`
- **Test de verification:** Revue manuelle
- **Responsable:** User

---

## Phase 1 - Domain Layer

### P1-01: Model SitePage
- **Statut:** `[ ]` TODO
- **Fichier a creer:** `archon/domain/models/site_page.py`
- **Contenu:**
  ```python
  class SitePageMetadata(BaseModel): ...
  class SitePage(BaseModel): ...
  ```
- **Test de verification:** `pytest tests/domain/test_models.py::test_site_page`
- **Responsable:** Coding Agent

### P1-02: Model SearchResult
- **Statut:** `[ ]` TODO
- **Fichier a creer:** `archon/domain/models/search_result.py`
- **Contenu:**
  ```python
  class SearchResult(BaseModel): ...
  ```
- **Test de verification:** `pytest tests/domain/test_models.py::test_search_result`
- **Responsable:** Coding Agent

### P1-03: Interface ISitePagesRepository
- **Statut:** `[ ]` TODO
- **Fichier a creer:** `archon/domain/interfaces/site_pages_repository.py`
- **Methodes a definir:**
  - `get_by_id(id: int) -> Optional[SitePage]`
  - `find_by_url(url: str) -> List[SitePage]`
  - `search_similar(embedding, limit, filter) -> List[SearchResult]`
  - `list_unique_urls(source: str) -> List[str]`
  - `insert(page: SitePage) -> SitePage`
  - `insert_batch(pages: List[SitePage]) -> List[SitePage]`
  - `delete_by_source(source: str) -> int`
  - `count(filter: Optional[dict]) -> int`
- **Test de verification:** `pytest tests/domain/test_interfaces.py::test_repository_interface`
- **Responsable:** Coding Agent

### P1-04: Interface IEmbeddingService
- **Statut:** `[ ]` TODO
- **Fichier a creer:** `archon/domain/interfaces/embedding_service.py`
- **Methodes a definir:**
  - `get_embedding(text: str) -> List[float]`
  - `get_embeddings_batch(texts: List[str]) -> List[List[float]]`
- **Test de verification:** `pytest tests/domain/test_interfaces.py::test_embedding_interface`
- **Responsable:** Coding Agent

### P1-05: Module domain __init__
- **Statut:** `[ ]` TODO
- **Fichiers a creer:**
  - `archon/domain/__init__.py`
  - `archon/domain/models/__init__.py`
  - `archon/domain/interfaces/__init__.py`
- **Test de verification:** `python -c "from archon.domain import SitePage, ISitePagesRepository"`
- **Responsable:** Coding Agent

### P1-06: Tests unitaires Domain
- **Statut:** `[ ]` TODO
- **Fichiers a creer:**
  - `tests/domain/__init__.py`
  - `tests/domain/test_models.py`
  - `tests/domain/test_interfaces.py`
- **Test de verification:** `pytest tests/domain/ -v --cov=archon/domain`
- **Responsable:** Coding Agent

---

## Phase 2 - Infrastructure

### P2-01: Mappers Supabase <-> Domain
- **Statut:** `[ ]` TODO
- **Fichier a creer:** `archon/infrastructure/supabase/mappers.py`
- **Fonctions:**
  - `dict_to_site_page(data: dict) -> SitePage`
  - `site_page_to_dict(page: SitePage) -> dict`
  - `dict_to_search_result(data: dict) -> SearchResult`
- **Test de verification:** `pytest tests/infrastructure/test_mappers.py`
- **Responsable:** Coding Agent

### P2-02: SupabaseSitePagesRepository
- **Statut:** `[ ]` TODO
- **Fichier a creer:** `archon/infrastructure/supabase/site_pages_repository.py`
- **Implemente:** `ISitePagesRepository`
- **Blocs a migrer depuis:**

| ID | Source | Lignes | Methode cible |
|----|--------|--------|---------------|
| P2-02a | `agent_tools.py` | 30-37 | `search_similar()` |
| P2-02b | `agent_tools.py` | 70-73 | `list_unique_urls()` |
| P2-02c | `agent_tools.py` | 99-104 | `find_by_url()` |
| P2-02d | `crawl_pydantic_ai_docs.py` | 261 | `insert_batch()` |
| P2-02e | `crawl_pydantic_ai_docs.py` | 426 | `delete_by_source()` |
| P2-02f | `database.py` | 100 | `find_by_url()` |
| P2-02g | `database.py` | 104 | `count()` |
| P2-02h | `database.py` | 166 | `delete_by_source()` |
| P2-02i | `documentation.py` | 140 | `count()` |
| P2-02j | `documentation.py` | 149 | `find_by_url()` |

- **Test de verification:** `pytest tests/infrastructure/test_supabase_repository.py`
- **Responsable:** Coding Agent

### P2-03: InMemorySitePagesRepository
- **Statut:** `[ ]` TODO
- **Fichier a creer:** `archon/infrastructure/memory/site_pages_repository.py`
- **Implemente:** `ISitePagesRepository`
- **Usage:** Tests unitaires sans DB
- **Test de verification:** `pytest tests/infrastructure/test_memory_repository.py`
- **Responsable:** Coding Agent

### P2-04: OpenAIEmbeddingService
- **Statut:** `[ ]` TODO
- **Fichier a creer:** `archon/infrastructure/openai/embedding_service.py`
- **Implemente:** `IEmbeddingService`
- **Migre depuis:** `utils/utils.py::get_clients()` (partie OpenAI)
- **Test de verification:** `pytest tests/infrastructure/test_embedding_service.py`
- **Responsable:** Coding Agent

### P2-05: Module infrastructure __init__
- **Statut:** `[ ]` TODO
- **Fichiers a creer:**
  - `archon/infrastructure/__init__.py`
  - `archon/infrastructure/supabase/__init__.py`
  - `archon/infrastructure/memory/__init__.py`
  - `archon/infrastructure/openai/__init__.py`
- **Test de verification:** `python -c "from archon.infrastructure.supabase import SupabaseSitePagesRepository"`
- **Responsable:** Coding Agent

### P2-06: Logging Infrastructure pour Repository
- **Statut:** `[ ]` TODO
- **Fichier a creer:** `archon/infrastructure/logging.py`
- **Fonctionnalites:**
  - Decorator `@log_repository_call` pour tracer les appels
  - Logging des parametres d'entree (query, filters, etc.)
  - Logging des temps de reponse
  - Logging des resultats (count, success/failure)
  - Configuration par niveau (DEBUG, INFO, WARNING, ERROR)
- **Integration:**
  - Appliquer sur `SupabaseSitePagesRepository`
  - Appliquer sur `InMemorySitePagesRepository` (optionnel)
  - Appliquer sur `OpenAIEmbeddingService`
- **Format de log suggere:**
  ```
  [REPOSITORY] search_similar(query_len=1536, limit=5, filter={'source': 'pydantic_ai_docs'}) -> 5 results in 123ms
  [REPOSITORY] insert_batch(count=10) -> OK in 456ms
  [EMBEDDING] get_embedding(text_len=150) -> 1536 dims in 89ms
  ```
- **Test de verification:** `pytest tests/infrastructure/test_logging.py`
- **Responsable:** Coding Agent
- **Note:** Permet de comparer le comportement avant/apres refactorisation et de debugger facilement

---

## Phase 3 - Migration des Consommateurs

### P3-01: Container DI
- **Statut:** `[ ]` TODO
- **Fichier a creer:** `archon/container.py`
- **Contenu:**
  - Singleton pour `ISitePagesRepository`
  - Singleton pour `IEmbeddingService`
  - Factory `get_repository()`, `get_embedding_service()`
- **Test de verification:** `pytest tests/test_container.py`
- **Responsable:** Coding Agent

### P3-02: Migration utils/utils.py
- **Statut:** `[ ]` TODO
- **Fichier:** `utils/utils.py`
- **Blocs a modifier:**

| ID | Lignes | Action | Nouveau code |
|----|--------|--------|--------------|
| P3-02a | 1 | Supprimer import | ~~`from supabase import Client, create_client`~~ |
| P3-02b | 404 | Supprimer instanciation | ~~`supabase: Client = Client(...)`~~ |
| P3-02c | 398-409 | Modifier `get_clients()` | Utiliser `container.get_repository()` |

- **Test de verification:** `pytest tests/characterization/test_utils.py`
- **Responsable:** Coding Agent

### P3-03: Migration agent_tools.py
- **Statut:** `[ ]` TODO
- **Fichier:** `archon/agent_tools.py`
- **Blocs a modifier:**

| ID | Lignes | Bloc actuel | Action |
|----|--------|-------------|--------|
| P3-03a | 3 | `from supabase import Client` | Supprimer, importer `ISitePagesRepository` |
| P3-03b | 24 | `supabase: Client` dans signature | Changer en `repository: ISitePagesRepository` |
| P3-03c | 30-37 | `supabase.rpc('match_site_pages')` | Remplacer par `repository.search_similar()` |
| P3-03d | 59 | `supabase: Client` dans signature | Changer en `repository: ISitePagesRepository` |
| P3-03e | 70-73 | `supabase.from_().select().eq()` | Remplacer par `repository.list_unique_urls()` |
| P3-03f | 86 | `supabase: Client` dans signature | Changer en `repository: ISitePagesRepository` |
| P3-03g | 99-104 | `supabase.from_().select().order()` | Remplacer par `repository.find_by_url()` |

- **Test de verification:** `pytest tests/characterization/test_agent_tools.py`
- **Responsable:** Coding Agent

### P3-04: Migration crawl_pydantic_ai_docs.py
- **Statut:** `[ ]` TODO
- **Fichier:** `archon/crawl_pydantic_ai_docs.py`
- **Blocs a modifier:**

| ID | Lignes | Bloc actuel | Action |
|----|--------|-------------|--------|
| P3-04a | 28 | `get_clients()` niveau module | Injecter via parametre ou container |
| P3-04b | 261 | `supabase.table().insert()` | Remplacer par `repository.insert_batch()` |
| P3-04c | 426 | `supabase.table().delete()` | Remplacer par `repository.delete_by_source()` |

- **Test de verification:** `pytest tests/characterization/test_crawl.py`
- **Responsable:** Coding Agent

### P3-05: Migration streamlit_pages/database.py
- **Statut:** `[ ]` TODO
- **Fichier:** `streamlit_pages/database.py`
- **Blocs a modifier:**

| ID | Lignes | Bloc actuel | Action |
|----|--------|-------------|--------|
| P3-05a | 100 | `supabase.table().select().limit()` | Remplacer par `repository.find_by_url()` |
| P3-05b | 104 | `supabase.table().select(count='exact')` | Remplacer par `repository.count()` |
| P3-05c | 166 | `supabase.table().delete().neq()` | Remplacer par `repository.delete_by_source()` |

- **Test de verification:** `pytest tests/characterization/test_database_page.py`
- **Responsable:** Coding Agent

### P3-06: Migration streamlit_pages/documentation.py
- **Statut:** `[ ]` TODO
- **Fichier:** `streamlit_pages/documentation.py`
- **Blocs a modifier:**

| ID | Lignes | Bloc actuel | Action |
|----|--------|-------------|--------|
| P3-06a | 10 | `def documentation_tab(supabase_client)` | Changer signature en `repository: ISitePagesRepository` |
| P3-06b | 140 | `supabase_client.table().select(count='exact')` | Remplacer par `repository.count()` |
| P3-06c | 149 | `supabase_client.table().select().limit()` | Remplacer par `repository.find_by_url()` |

- **Test de verification:** `pytest tests/characterization/test_documentation_page.py`
- **Responsable:** Coding Agent

### P3-07: Migration archon_graph.py
- **Statut:** `[ ]` TODO
- **Fichier:** `archon/archon_graph.py`
- **Blocs a modifier:**

| ID | Lignes | Bloc actuel | Action |
|----|--------|-------------|--------|
| P3-07a | 11 | `from supabase import Client` | Supprimer |
| P3-07b | 67 | `embedding_client, supabase = get_clients()` | Utiliser `container.get_repository()` |
| P3-07c | 85 | `await list_documentation_pages_tool(supabase)` | Passer `repository` |
| P3-07d | 149 | `supabase=supabase` dans deps | Changer en `repository=repository` |
| P3-07e | 251 | `supabase=supabase` dans deps | Changer en `repository=repository` |
| P3-07f | 272 | `supabase=supabase` dans deps | Changer en `repository=repository` |

- **Test de verification:** `pytest tests/characterization/test_archon_graph.py`
- **Responsable:** Coding Agent

### P3-08: Migration pydantic_ai_coder.py
- **Statut:** `[ ]` TODO
- **Fichier:** `archon/pydantic_ai_coder.py`
- **Blocs a modifier:**

| ID | Lignes | Bloc actuel | Action |
|----|--------|-------------|--------|
| P3-08a | 17 | `from supabase import Client` | Importer `ISitePagesRepository` |
| P3-08b | 42 | `supabase: Client` dans dataclass | Changer en `repository: ISitePagesRepository` |
| P3-08c | 66-102 | Tools utilisant `ctx.deps.supabase` | Utiliser `ctx.deps.repository` |

- **Test de verification:** `pytest tests/characterization/test_pydantic_ai_coder.py`
- **Responsable:** Coding Agent

### P3-09: Migration advisor_agent.py
- **Statut:** `[ ]` TODO
- **Fichier:** `archon/advisor_agent.py`
- **Blocs a modifier:**

| ID | Lignes | Bloc actuel | Action |
|----|--------|-------------|--------|
| P3-09a | 17 | `from supabase import Client` | **Supprimer** (import non utilise) |

- **Note:** L'import `Client` n'est pas utilise dans ce fichier. Simple nettoyage.
- **Test de verification:** `pytest tests/characterization/test_advisor_agent.py`
- **Responsable:** Coding Agent

### P3-10: Migration tools_refiner_agent.py
- **Statut:** `[ ]` TODO
- **Fichier:** `archon/refiner_agents/tools_refiner_agent.py`
- **Blocs a modifier:**

| ID | Lignes | Bloc actuel | Action |
|----|--------|-------------|--------|
| P3-10a | 17 | `from supabase import Client` | Importer `ISitePagesRepository` |
| P3-10b | 44 | `supabase: Client` dans dataclass | Changer en `repository: ISitePagesRepository` |

- **Test de verification:** `pytest tests/characterization/test_tools_refiner.py`
- **Responsable:** Coding Agent

### P3-11: Migration agent_refiner_agent.py
- **Statut:** `[ ]` TODO
- **Fichier:** `archon/refiner_agents/agent_refiner_agent.py`
- **Blocs a modifier:**

| ID | Lignes | Bloc actuel | Action |
|----|--------|-------------|--------|
| P3-11a | 17 | `from supabase import Client` | Importer `ISitePagesRepository` |
| P3-11b | 43 | `supabase: Client` dans dataclass | Changer en `repository: ISitePagesRepository` |

- **Test de verification:** `pytest tests/characterization/test_agent_refiner.py`
- **Responsable:** Coding Agent

### P3-12: Migration prompt_refiner_agent.py
- **Statut:** `[ ]` TODO
- **Fichier:** `archon/refiner_agents/prompt_refiner_agent.py`
- **Blocs a modifier:**

| ID | Lignes | Bloc actuel | Action |
|----|--------|-------------|--------|
| P3-12a | 10 | `from supabase import Client` | **Supprimer** (import non utilise) |

- **Note:** L'import `Client` n'est pas utilise dans ce fichier. Simple nettoyage.
- **Test de verification:** `pytest tests/characterization/test_prompt_refiner.py`
- **Responsable:** Coding Agent

### P3-13: Services Layer
- **Statut:** `[ ]` TODO
- **Fichiers a creer:**
  - `archon/services/__init__.py`
  - `archon/services/documentation_service.py`
  - `archon/services/crawl_service.py`
- **Test de verification:** `pytest tests/services/`
- **Responsable:** Coding Agent

---

## Phase 4 - Nettoyage et Validation

### P4-01: Verification zero imports Supabase
- **Statut:** `[ ]` TODO
- **Commande:** `grep -rn "from supabase import" archon/ utils/ streamlit_pages/ --include="*.py" | grep -v infrastructure/`
- **Resultat attendu:** Aucune ligne trouvee
- **Test de verification:** Script CI/CD ou test automatise
- **Responsable:** Coding Agent

### P4-02: Suite de tests complete
- **Statut:** `[ ]` TODO
- **Commande:** `pytest tests/ -v --cov=archon --cov-report=html`
- **Resultat attendu:**
  - Tous les tests passent
  - Couverture > 70%
- **Test de verification:** `pytest` exit code 0
- **Responsable:** Coding Agent

### P4-03: Tests de performance
- **Statut:** `[ ]` TODO
- **Fichier a creer:** `tests/performance/test_benchmark.py`
- **Metriques:**
  - Temps de reponse `search_similar()` < 500ms
  - Temps de reponse `insert_batch(100)` < 2s
- **Test de verification:** `pytest tests/performance/ -v`
- **Responsable:** User

### P4-04: Documentation finale
- **Statut:** `[ ]` TODO
- **Fichiers a mettre a jour:**
  - `README.md` - Section architecture
  - `docs/ARCHITECTURE.md` - Nouveau fichier
  - Docstrings dans tous les modules domain/infrastructure
- **Test de verification:** Revue manuelle
- **Responsable:** User

---

## Registre des Modifications

| Date | Bloc ID | Statut | Commit | Teste par |
|------|---------|--------|--------|-----------|
| 2025-11-29 | - | Audit completude | - | Claude |

---

## Historique des Audits

| Date | Version | Ecarts trouves | Action |
|------|---------|----------------|--------|
| 2025-11-29 | 1.0 → 1.1 | +3 fichiers, +5 blocs | Ajout P3-09 (advisor), P3-12 (prompt_refiner), details P3-03/P3-06 |

---

## Inventaire Exhaustif des Usages Supabase

### Fichiers avec `from supabase import`

| # | Fichier | Ligne | Couvert par |
|---|---------|-------|-------------|
| 1 | `utils/utils.py` | 1 | P3-02a |
| 2 | `archon/agent_tools.py` | 3 | P3-03a |
| 3 | `archon/crawl_pydantic_ai_docs.py` | (indirect via get_clients) | P3-04a |
| 4 | `archon/archon_graph.py` | 11 | P3-07a |
| 5 | `archon/pydantic_ai_coder.py` | 17 | P3-08a |
| 6 | `archon/advisor_agent.py` | 17 | P3-09a |
| 7 | `archon/refiner_agents/tools_refiner_agent.py` | 17 | P3-10a |
| 8 | `archon/refiner_agents/agent_refiner_agent.py` | 17 | P3-11a |
| 9 | `archon/refiner_agents/prompt_refiner_agent.py` | 10 | P3-12a |

### Fichiers avec `: Client` dans signatures/dataclasses

| # | Fichier | Ligne | Couvert par |
|---|---------|-------|-------------|
| 1 | `utils/utils.py` | 404 | P3-02b |
| 2 | `archon/agent_tools.py` | 24, 59, 86 | P3-03b, P3-03d, P3-03f |
| 3 | `archon/pydantic_ai_coder.py` | 42 | P3-08b |
| 4 | `archon/refiner_agents/tools_refiner_agent.py` | 44 | P3-10b |
| 5 | `archon/refiner_agents/agent_refiner_agent.py` | 43 | P3-11b |

### Fichiers avec appels `supabase.` directs

| # | Fichier | Lignes | Couvert par |
|---|---------|--------|-------------|
| 1 | `archon/agent_tools.py` | 30, 70, 99 | P3-03c, P3-03e, P3-03g |
| 2 | `archon/crawl_pydantic_ai_docs.py` | 261, 426 | P3-04b, P3-04c |
| 3 | `streamlit_pages/database.py` | 100, 104, 166 | P3-05a, P3-05b, P3-05c |
| 4 | `streamlit_pages/documentation.py` | 140, 149 | P3-06b, P3-06c |

---

## Notes de Mise a Jour

Pour mettre a jour ce manifest:

1. Changer le statut `[ ]` -> `[x]` quand le code est modifie
2. Changer `[x]` -> `[v]` quand le test passe
3. Ajouter une ligne dans le Registre des Modifications
4. Mettre a jour les compteurs dans "Progression Globale"

---

*Manifest genere le 2025-11-29*
*Derniere mise a jour: 2025-11-29 - Audit de completude v1.1*
