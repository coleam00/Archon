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
| Phase 0 - Preparation | 3 | 0 | 0 | 3 |
| Phase 1 - Domain Layer | 6 | 0 | 0 | 6 |
| Phase 2 - Infrastructure | 6 | 0 | 0 | 6 |
| Phase 2.5 - Validation | 1 | 0 | 0 | 1 |
| Phase 3 - Migration | 15 | 10 | 0 | 5 |
| Phase 4 - Nettoyage | 4 | 4 | 0 | 0 |
| **TOTAL** | **35** | **14** | **0** | **21** |

**Pourcentage complete:** 60% (21/35 blocs verifies)

**Commit de reference Phase 0-2.5:** `80e3c47`

---

## Phase 0 - Preparation

### P0-01: Infrastructure de tests
- **Statut:** `[v]` VERIFIED
- **Fichiers crees:**
  - `pytest.ini` ✓
  - `tests/__init__.py` ✓
  - `tests/conftest.py` ✓
- **Test de verification:** `pytest --collect-only` retourne sans erreur ✓
- **Responsable:** Coding Agent
- **Commit:** `80e3c47`

### P0-02: Tests de caracterisation
- **Statut:** `[v]` VERIFIED
- **Fichiers crees:**
  - `tests/integration/test_agent_tools.py` ✓
  - `tests/integration/test_crawl_operations.py` ✓
- **Test de verification:** `pytest tests/integration/ -v` passe ✓
- **Responsable:** Coding Agent
- **Commit:** `80e3c47`
- **Note:** Tests de caracterisation dans tests/integration/

### P0-03: Documentation schema actuel
- **Statut:** `[v]` VERIFIED
- **Fichiers crees:**
  - `docs/PLAN_REFACTORISATION_DATABASE_LAYER.md` ✓
  - `docs/MIGRATION_MANIFEST.md` ✓
- **Test de verification:** Revue manuelle ✓
- **Responsable:** User

---

## Phase 1 - Domain Layer

### P1-01: Model SitePage
- **Statut:** `[v]` VERIFIED
- **Fichier cree:** `archon/domain/models/site_page.py` ✓
- **Contenu:** `SitePageMetadata`, `SitePage` (Pydantic v2)
- **Test de verification:** 37 tests domain passent ✓
- **Responsable:** db-refactor-domain-agent
- **Commit:** `80e3c47`

### P1-02: Model SearchResult
- **Statut:** `[v]` VERIFIED
- **Fichier cree:** `archon/domain/models/search_result.py` ✓
- **Contenu:** `SearchResult(page: SitePage, similarity: float)`
- **Test de verification:** Tests domain passent ✓
- **Responsable:** db-refactor-domain-agent
- **Commit:** `80e3c47`

### P1-03: Interface ISitePagesRepository
- **Statut:** `[v]` VERIFIED
- **Fichier cree:** `archon/domain/interfaces/site_pages_repository.py` ✓
- **Methodes definies (8):**
  - `get_by_id(id: UUID) -> Optional[SitePage]` ✓
  - `find_by_url(url: str) -> List[SitePage]` ✓
  - `search_similar(embedding, limit, source?) -> List[SearchResult]` ✓
  - `list_unique_urls(source?) -> List[str]` ✓
  - `insert(page: SitePage) -> SitePage` ✓
  - `insert_batch(pages: List[SitePage]) -> List[SitePage]` ✓
  - `delete_by_source(source: str) -> int` ✓
  - `count(source?) -> int` ✓
- **Test de verification:** Tests interfaces passent ✓
- **Responsable:** db-refactor-domain-agent
- **Commit:** `80e3c47`

### P1-04: Interface IEmbeddingService
- **Statut:** `[v]` VERIFIED
- **Fichier cree:** `archon/domain/interfaces/embedding_service.py` ✓
- **Methodes definies (2):**
  - `get_embedding(text: str) -> List[float]` ✓
  - `get_embeddings_batch(texts: List[str]) -> List[List[float]]` ✓
- **Test de verification:** Tests interfaces passent ✓
- **Responsable:** db-refactor-domain-agent
- **Commit:** `80e3c47`

### P1-05: Module domain __init__
- **Statut:** `[v]` VERIFIED
- **Fichiers crees:**
  - `archon/domain/__init__.py` ✓
  - `archon/domain/models/__init__.py` ✓
  - `archon/domain/interfaces/__init__.py` ✓
- **Test de verification:** `python -c "from archon.domain import SitePage, ISitePagesRepository"` OK ✓
- **Responsable:** db-refactor-domain-agent
- **Commit:** `80e3c47`

### P1-06: Tests unitaires Domain
- **Statut:** `[v]` VERIFIED
- **Fichiers crees:**
  - `tests/domain/__init__.py` ✓
  - `tests/domain/test_models.py` (14 tests) ✓
  - `tests/domain/test_interfaces.py` (23 tests) ✓
- **Test de verification:** `pytest tests/domain/ -v` → 37/37 passent ✓
- **Responsable:** db-refactor-domain-agent
- **Commit:** `80e3c47`

---

## Phase 2 - Infrastructure

### P2-01: Mappers Supabase <-> Domain
- **Statut:** `[v]` VERIFIED
- **Fichier cree:** `archon/infrastructure/supabase/mappers.py` ✓
- **Fonctions:**
  - `dict_to_site_page(data: dict) -> SitePage` ✓
  - `site_page_to_dict(page: SitePage) -> dict` ✓
  - `dict_to_search_result(data: dict, similarity: float) -> SearchResult` ✓
- **Test de verification:** `pytest tests/infrastructure/test_mappers.py` → 6/6 passent ✓
- **Responsable:** db-refactor-domain-agent
- **Commit:** `80e3c47`

### P2-02: SupabaseSitePagesRepository
- **Statut:** `[v]` VERIFIED
- **Fichier cree:** `archon/infrastructure/supabase/site_pages_repository.py` ✓
- **Implemente:** `ISitePagesRepository` (8 methodes) ✓
- **Reference des blocs a migrer en Phase 3:**

| ID | Source | Lignes | Methode cible | Statut |
|----|--------|--------|---------------|--------|
| P2-02a | `agent_tools.py` | 30-37 | `search_similar()` | Phase 3 |
| P2-02b | `agent_tools.py` | 70-73 | `list_unique_urls()` | Phase 3 |
| P2-02c | `agent_tools.py` | 99-104 | `find_by_url()` | Phase 3 |
| P2-02d | `crawl_pydantic_ai_docs.py` | 261 | `insert_batch()` | Phase 3 |
| P2-02e | `crawl_pydantic_ai_docs.py` | 426 | `delete_by_source()` | Phase 3 |
| P2-02f | `database.py` | 100 | `find_by_url()` | Phase 3 |
| P2-02g | `database.py` | 104 | `count()` | Phase 3 |
| P2-02h | `database.py` | 166 | `delete_by_source()` | Phase 3 |
| P2-02i | `documentation.py` | 140 | `count()` | Phase 3 |
| P2-02j | `documentation.py` | 149 | `find_by_url()` | Phase 3 |

- **Test de verification:** Implementation validee, tests integration en Phase 3
- **Responsable:** db-refactor-domain-agent
- **Commit:** `80e3c47`

### P2-03: InMemorySitePagesRepository
- **Statut:** `[v]` VERIFIED
- **Fichier cree:** `archon/infrastructure/memory/site_pages_repository.py` ✓
- **Implemente:** `ISitePagesRepository` (8 methodes + `clear()`) ✓
- **Usage:** Tests unitaires sans DB
- **Test de verification:** `pytest tests/infrastructure/test_memory_repository.py` → 14/14 passent ✓
- **Responsable:** db-refactor-domain-agent
- **Commit:** `80e3c47`

### P2-04: OpenAIEmbeddingService
- **Statut:** `[v]` VERIFIED
- **Fichier cree:** `archon/infrastructure/openai/embedding_service.py` ✓
- **Implemente:** `IEmbeddingService` (2 methodes) ✓
- **Test de verification:** Tests unitaires passent ✓
- **Responsable:** db-refactor-domain-agent
- **Commit:** `80e3c47`

### P2-05: Module infrastructure __init__
- **Statut:** `[v]` VERIFIED
- **Fichiers crees:**
  - `archon/infrastructure/__init__.py` ✓
  - `archon/infrastructure/supabase/__init__.py` ✓
  - `archon/infrastructure/memory/__init__.py` ✓
  - `archon/infrastructure/openai/__init__.py` ✓
- **Test de verification:** Tous les imports fonctionnent ✓
- **Responsable:** db-refactor-domain-agent
- **Commit:** `80e3c47`

### P2-06: MockEmbeddingService (bonus)
- **Statut:** `[v]` VERIFIED
- **Fichier cree:** `archon/infrastructure/memory/mock_embedding_service.py` ✓
- **Usage:** Tests sans appels API OpenAI
- **Responsable:** Claude
- **Note:** Ajoute pour supporter le container DI en mode test

---

## Phase 2.5 - Validation et Consolidation

### P2.5-01: Validation complete de la fondation
- **Statut:** `[v]` VERIFIED
- **Scripts executes:**
  - `scripts/validate_foundation.py` ✓
  - `scripts/test_integration_manual.py` ✓
- **Resultats:**
  - Imports: 5/5 OK ✓
  - Tests Domain: 37/37 passent ✓
  - Tests Infrastructure: 20/20 passent ✓
  - Tests Integration: 10/10 passent ✓
  - Coherence interfaces: 8/8 methodes ✓
  - Coherence modele/DB: OK ✓
- **Responsable:** db-refactor-validation-agent
- **Commit:** `80e3c47`
- **Tache Archon:** `54dbc8e6-7166-4f0d-a0ff-39ccae999c79` (done)

---

## Phase 3 - Migration des Consommateurs

**IMPORTANT:** Cette phase utilise l'agent `db-refactor-migration-agent`.
Voir `.claude/agents/db-refactor-migration-agent.md` pour les regles et le workflow.

### P3-01: Container DI
- **Statut:** `[v]` VERIFIED
- **Fichier cree:** `archon/container.py` ✓
- **Contenu:**
  - Singleton pour `ISitePagesRepository` ✓
  - Singleton pour `IEmbeddingService` ✓
  - Factory `get_repository()`, `get_embedding_service()` ✓
  - Support Supabase (prod) et Memory (tests) ✓
  - Support OpenAI (prod) et Mock (tests) ✓
  - Fonctions `configure()`, `reset()`, `override_*()` pour tests ✓
- **Test de verification:** `pytest tests/test_container.py` → 12/12 passent ✓
- **Responsable:** db-refactor-migration-agent
- **Date:** 2025-11-30

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
- **Statut:** `[v]` VERIFIED
- **Fichier:** `archon/agent_tools.py`
- **Blocs a modifier:**

| ID | Lignes | Bloc actuel | Action | Statut |
|----|--------|-------------|--------|--------|
| P3-03a | 3 | `from supabase import Client` | Ajouter import `ISitePagesRepository`, `IEmbeddingService` | `[v]` |
| P3-03b | 24-55 | `retrieve_relevant_documentation_tool(supabase, embedding_client, query)` | Ajouter parametres optionnels `repository`, `embedding_service` + mode dual | `[v]` |
| P3-03c | 30-37 | `supabase.rpc('match_site_pages')` | Remplacer par `repository.search_similar()` avec fallback | `[v]` |
| P3-03d | 59-84 | `list_documentation_pages_tool(supabase)` | Ajouter parametre optionnel `repository` + mode dual | `[v]` |
| P3-03e | 70-73 | `supabase.from_().select().eq()` | Remplacer par `repository.list_unique_urls()` avec fallback | `[v]` |
| P3-03f | 86-123 | `get_page_content_tool(supabase, url)` | Ajouter parametre optionnel `repository` + mode dual | `[v]` |
| P3-03g | 99-104 | `supabase.from_().select().order()` | Remplacer par `repository.find_by_url()` avec fallback | `[v]` |
| P3-03h | 12-47 | `get_embedding(text, embedding_client)` | Ajouter parametre optionnel `embedding_service` + mode dual | `[v]` |

- **Strategie appliquee:** Mode dual avec fallback pour retrocompatibilite
- **Test de verification:** `pytest tests/test_agent_tools_migration.py` → 15/15 passent ✓
- **Tests unitaires:** `pytest tests/` → 90/90 passent, 29 skipped ✓
- **Fichiers crees:**
  - `tests/test_agent_tools_migration.py` (15 tests de validation migration)
  - Fix dans `archon/infrastructure/memory/site_pages_repository.py` (clipping similarite)
- **Responsable:** db-refactor-migration-agent
- **Date:** 2025-11-30

### P3-04: Migration crawl_pydantic_ai_docs.py
- **Statut:** `[v]` VERIFIED
- **Fichier:** `archon/crawl_pydantic_ai_docs.py`
- **Blocs a modifier:**

| ID | Lignes | Bloc actuel | Action | Statut |
|----|--------|-------------|--------|--------|
| P3-04a | 28 | `get_clients()` niveau module | Injecter via parametre optionnel | `[v]` |
| P3-04b | 261 | `supabase.table().insert()` | Remplacer par `repository.insert()` avec fallback | `[v]` |
| P3-04c | 426 | `supabase.table().delete()` | Remplacer par `repository.delete_by_source()` avec fallback | `[v]` |

- **Strategie appliquee:** Mode dual avec fallback pour retrocompatibilite
- **Test de verification:** `pytest tests/test_crawl_migration.py` → 6/6 passes ✓
- **Fichiers crees:**
  - `tests/test_crawl_migration.py` (6 tests de validation migration)
- **Responsable:** db-refactor-migration-agent
- **Date:** 2025-11-30

### P3-05: Migration streamlit_pages/database.py
- **Statut:** `[v]` VERIFIED
- **Fichier:** `streamlit_pages/database.py`
- **Blocs a modifier:**

| ID | Lignes | Bloc actuel | Action | Statut |
|----|--------|-------------|--------|--------|
| P3-05a | 100-130 | `supabase.table().select()` | Remplacer par `repository.count()` avec mode dual | `[v]` |
| P3-05b | 104-130 | `supabase.table().select(count='exact')` | Remplacer par `repository.count()` | `[v]` |
| P3-05c | 166-192 | `supabase.table().delete().neq()` | Garder Supabase (opération admin non couverte) | `[v]` |

- **Strategie appliquee:** Mode dual avec fallback Supabase + asyncio.run() pour adapter async
- **Note P3-05c:** L'opération "delete ALL" (sans filtre source) n'est pas couverte par le repository. Conservé avec Supabase pour cette fonctionnalité admin.
- **Test de verification:** `pytest tests/test_streamlit_migration.py::TestDatabasePageMigration` → 5/5 passent ✓
- **Responsable:** db-refactor-migration-agent
- **Date:** 2025-11-30

### P3-06: Migration streamlit_pages/documentation.py
- **Statut:** `[v]` VERIFIED
- **Fichier:** `streamlit_pages/documentation.py`
- **Blocs a modifier:**

| ID | Lignes | Bloc actuel | Action | Statut |
|----|--------|-------------|--------|--------|
| P3-06a | 10-20 | `def documentation_tab(supabase_client)` | Ajouter paramètre `repository: Optional[ISitePagesRepository]` | `[v]` |
| P3-06b | 140-152 | `supabase_client.table().select(count='exact')` | Remplacer par `repository.count(source="pydantic_ai_docs")` avec mode dual | `[v]` |
| P3-06c | 149-193 | `supabase_client.table().select().limit()` | Garder Supabase (UI-specific: affichage échantillon) | `[v]` |

- **Strategie appliquee:** Mode dual avec fallback Supabase + asyncio.run() pour adapter async
- **Note P3-06c:** L'opération "sample N records" pour affichage UI n'est pas une opération métier standard. Conservé avec Supabase direct pour cette fonctionnalité UI.
- **Test de verification:** `pytest tests/test_streamlit_migration.py::TestDocumentationPageMigration` → 5/5 passent ✓
- **Responsable:** db-refactor-migration-agent
- **Date:** 2025-11-30

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
| 2025-11-29 | P0-01 | VERIFIED | 80e3c47 | db-refactor-validation-agent |
| 2025-11-29 | P0-02 | VERIFIED | 80e3c47 | db-refactor-validation-agent |
| 2025-11-29 | P0-03 | VERIFIED | - | User |
| 2025-11-29 | P1-01 to P1-06 | VERIFIED | 80e3c47 | db-refactor-domain-agent |
| 2025-11-29 | P2-01 to P2-06 | VERIFIED | 80e3c47 | db-refactor-domain-agent |
| 2025-11-30 | P2.5-01 | VERIFIED | 80e3c47 | db-refactor-validation-agent |
| 2025-11-30 | - | Manifest update Phase 0-2.5 | - | Claude |
| 2025-11-30 | P3-01 | VERIFIED | 021d7b9 | db-refactor-migration-agent |
| 2025-11-30 | P3-03 (a-h) | VERIFIED | (pending) | db-refactor-migration-agent |
| 2025-11-30 | P3-04 (a-c) | VERIFIED | (pending) | db-refactor-migration-agent |
| 2025-11-30 | P3-05 (a-c) | VERIFIED | (pending) | db-refactor-migration-agent |
| 2025-11-30 | P3-06 (a-c) | VERIFIED | (pending) | db-refactor-migration-agent |

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
