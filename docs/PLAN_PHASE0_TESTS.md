# Plan Phase 0 - Infrastructure de Tests

**Version:** 1.0
**Date:** 2025-11-29
**Projet:** Refactorisation Database Layer Archon
**Statut:** Approuve

---

## Resume Executif

Ce document consolide la strategie de tests pour la Phase 0 du projet de refactorisation. Il integre les decisions prises et l'infrastructure disponible.

**Decision principale:** Approche hybride utilisant:
- **Supabase Cloud** (production) pour les tests de caracterisation (comportement reel)
- **PostgreSQL Docker local** (`mg_postgres`) pour les tests unitaires rapides

**Infrastructure disponible:**
- Archon MCP Server actif (uptime 4+ jours)
- PostgreSQL Docker `mg_postgres` sur `localhost:5432`
- Supabase Cloud (production actuelle)

---

## 1. Contexte et Probleme Resolu

### 1.1 Le Probleme P0/P2

Le plan original contenait une contradiction logique:
- **Phase 0 (P0-02):** Ecrire les tests de caracterisation AVANT refactorisation
- **Phase 2 (P2-03):** Creer InMemoryRepository pour les tests

**Probleme:** Comment tester en Phase 0 sans l'outil de test de Phase 2?

### 1.2 Solution Adoptee

**Approche hybride en deux niveaux:**

| Niveau | Environnement | Usage | Quand |
|--------|---------------|-------|-------|
| **Tests d'integration** | Supabase Cloud | Capturer le comportement REEL actuel | Phase 0 |
| **Tests unitaires** | PostgreSQL Docker local | Developpement rapide, CI/CD | Phase 0+ |

**Avantages:**
- Fidelite 100% avec Supabase Cloud pour la reference
- Tests gratuits et rapides avec PostgreSQL local
- Validation que l'abstraction fonctionne sur les deux backends

---

## 2. Infrastructure Disponible

### 2.1 Supabase Cloud (Production)

```
URL: ${SUPABASE_URL} (configure dans .env)
Key: ${SUPABASE_SERVICE_KEY} (configure dans .env)

Table: site_pages
- id (bigserial)
- url (varchar)
- chunk_number (integer)
- title (varchar)
- summary (varchar)
- content (text)
- metadata (jsonb)
- embedding (vector(1536))
- created_at (timestamptz)

Fonction RPC: match_site_pages(query_embedding, match_count, filter)
Index: ivfflat sur embedding
```

**Usage:** Tests de caracterisation - comportement de reference

### 2.2 PostgreSQL Docker Local

```
Container: mg_postgres
Image: postgres:latest
Host: localhost
Port: 5432
User: postgres
Password: postgres
Database: mydb (existante) ou archon_test (a creer)
Volume: mg_backend_postgres_data (persistant)
Status: Up 4+ jours
```

**Usage:** Tests unitaires rapides, developpement, CI/CD

### 2.3 Archon MCP Server

```
Status: Healthy
API Service: Active
Agents Service: Active
Uptime: 4+ jours
```

**Usage:** Validation end-to-end que le systeme fonctionne

---

## 3. Decisions (Q1-Q5 Resolues)

### Q1: Environnement de test - RESOLU

**Decision:** Approche hybride
- Tests de caracterisation → Supabase Cloud (production avec isolation par `source='test_characterization'`)
- Tests unitaires → PostgreSQL Docker local (`mg_postgres`)

**Justification:** Infrastructure deja disponible, zero cout supplementaire

### Q2: Budget API - RESOLU

**Decision:** Budget minimal (~$1-5/mois)
- Tests d'integration Supabase: Quelques runs manuels avant PR
- Embeddings OpenAI: Utiliser fixtures pre-calculees quand possible

**Note:** PostgreSQL local = $0 pour les tests unitaires

### Q3: Strategie de tests - RESOLU

**Decision:** Option D amelioree (Approche hybride)
- Phase 0: Tests d'integration contre Supabase Cloud
- Phase 0+: Tests unitaires contre PostgreSQL local
- Phase 2: InMemoryRepository pour tests sans DB

### Q4: Responsable environnement - RESOLU

**Decision:**
- PostgreSQL Docker: Deja configure par DevOps (mg_postgres)
- Supabase Cloud: Utiliser l'environnement de production existant
- Responsable tests: Coding Agent (avec supervision User)

### Q5: CI/CD - RESOLU

**Decision:** Tests sur PR uniquement
- Tests unitaires (PostgreSQL local): Sur chaque PR
- Tests d'integration (Supabase): Manuels avant merge important

---

## 4. Plan d'Action Phase 0

### 4.1 Etape 1: Preparer PostgreSQL local (30 min)

**Taches:**
1. Creer la base de donnees `archon_test` sur `mg_postgres`
2. Deployer le schema `site_pages` (copie de Supabase)
3. Creer la fonction `match_site_pages` (version PostgreSQL)
4. Installer l'extension `pgvector`

**Script SQL a executer:**
```sql
-- Connexion: docker exec -it mg_postgres psql -U postgres

-- 1. Creer la base de test
CREATE DATABASE archon_test;

-- 2. Se connecter a archon_test
\c archon_test

-- 3. Installer pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- 4. Creer la table site_pages
CREATE TABLE site_pages (
    id BIGSERIAL PRIMARY KEY,
    url VARCHAR NOT NULL,
    chunk_number INTEGER NOT NULL,
    title VARCHAR,
    summary VARCHAR,
    content TEXT,
    metadata JSONB DEFAULT '{}',
    embedding VECTOR(1536),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(url, chunk_number)
);

-- 5. Creer les index
CREATE INDEX idx_site_pages_embedding ON site_pages
USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE INDEX idx_site_pages_metadata ON site_pages USING GIN (metadata);

-- 6. Creer la fonction match_site_pages
CREATE OR REPLACE FUNCTION match_site_pages(
    query_embedding VECTOR(1536),
    match_count INTEGER,
    filter JSONB DEFAULT '{}'
)
RETURNS TABLE (
    id BIGINT,
    url VARCHAR,
    chunk_number INTEGER,
    title VARCHAR,
    summary VARCHAR,
    content TEXT,
    metadata JSONB,
    similarity FLOAT
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        sp.id,
        sp.url,
        sp.chunk_number,
        sp.title,
        sp.summary,
        sp.content,
        sp.metadata,
        1 - (sp.embedding <=> query_embedding) AS similarity
    FROM site_pages sp
    WHERE (filter->>'source' IS NULL OR sp.metadata->>'source' = filter->>'source')
    ORDER BY sp.embedding <=> query_embedding
    LIMIT match_count;
END;
$$ LANGUAGE plpgsql;
```

**Validation:**
```bash
docker exec -it mg_postgres psql -U postgres -d archon_test -c "\dt"
# Devrait afficher: site_pages
```

### 4.2 Etape 2: Infrastructure pytest (1h)

**Fichiers a creer:**

```
tests/
  __init__.py
  conftest.py              # Fixtures globales
  pytest.ini               # Configuration pytest

  integration/             # Tests contre Supabase Cloud
    __init__.py
    conftest.py            # Fixtures Supabase
    test_agent_tools.py
    test_crawl_operations.py

  unit/                    # Tests contre PostgreSQL local
    __init__.py
    conftest.py            # Fixtures PostgreSQL local
    test_agent_tools.py
    test_repository.py

  fixtures/                # Donnees de test
    test_site_pages.json
    test_embeddings.json   # Embeddings pre-calcules
```

**pytest.ini:**
```ini
[pytest]
testpaths = tests
python_files = test_*.py
python_classes = Test*
python_functions = test_*
markers =
    integration: Tests necessitant Supabase Cloud
    unit: Tests avec PostgreSQL local ou mocks
    slow: Tests longs (embeddings, etc.)
asyncio_mode = auto
```

**conftest.py (global):**
```python
import pytest
import os

def pytest_configure(config):
    """Configuration globale pytest."""
    config.addinivalue_line("markers", "integration: Tests Supabase Cloud")
    config.addinivalue_line("markers", "unit: Tests PostgreSQL local")
    config.addinivalue_line("markers", "slow: Tests longs")

@pytest.fixture(scope="session")
def test_config():
    """Configuration des environnements de test."""
    return {
        "supabase": {
            "url": os.getenv("SUPABASE_URL"),
            "key": os.getenv("SUPABASE_SERVICE_KEY"),
        },
        "postgres_local": {
            "host": "localhost",
            "port": 5432,
            "user": "postgres",
            "password": "postgres",
            "database": "archon_test",
        }
    }
```

### 4.3 Etape 3: Tests de caracterisation (4-6h)

**Objectif:** Capturer le comportement ACTUEL avant refactorisation

**Tests a ecrire:**

| Fichier | Fonction testee | Type |
|---------|-----------------|------|
| `test_agent_tools.py` | `retrieve_relevant_documentation_tool` | Integration |
| `test_agent_tools.py` | `list_documentation_pages_tool` | Integration |
| `test_agent_tools.py` | `get_page_content_tool` | Integration |
| `test_crawl_operations.py` | Insert de chunks | Integration |
| `test_crawl_operations.py` | Delete par source | Integration |

**Exemple de test de caracterisation:**
```python
# tests/integration/test_agent_tools.py
import pytest
from archon.agent_tools import (
    retrieve_relevant_documentation_tool,
    list_documentation_pages_tool,
    get_page_content_tool
)

@pytest.mark.integration
class TestAgentToolsCharacterization:
    """Tests de caracterisation - comportement actuel."""

    async def test_retrieve_relevant_documentation_returns_list(self, supabase_client):
        """Verifie que la fonction retourne une liste de resultats."""
        result = await retrieve_relevant_documentation_tool(
            supabase_client,
            "pydantic agent"
        )
        assert isinstance(result, (list, str))
        # Capturer le format exact pour reference

    async def test_list_documentation_pages_format(self, supabase_client):
        """Verifie le format de retour de list_documentation_pages."""
        result = await list_documentation_pages_tool(supabase_client)
        assert isinstance(result, (list, str))
        # Si liste, verifier la structure des elements
```

### 4.4 Etape 4: Validation (1h)

**Checklist de validation Phase 0:**

- [ ] PostgreSQL local `archon_test` cree et fonctionnel
- [ ] Extension `pgvector` installee
- [ ] Table `site_pages` creee
- [ ] Fonction `match_site_pages` deployee
- [ ] `pytest --collect-only` retourne sans erreur
- [ ] Tests d'integration passent contre Supabase Cloud
- [ ] Tests unitaires passent contre PostgreSQL local
- [ ] Documentation a jour

---

## 5. Variables d'Environnement

### 5.1 Fichier .env (existant)

```bash
# Supabase Cloud (production)
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=eyJhbGc...

# OpenAI
OPENAI_API_KEY=sk-...
```

### 5.2 Fichier .env.test (a creer)

```bash
# PostgreSQL Local (tests)
POSTGRES_TEST_HOST=localhost
POSTGRES_TEST_PORT=5432
POSTGRES_TEST_USER=postgres
POSTGRES_TEST_PASSWORD=postgres
POSTGRES_TEST_DB=archon_test

# Optionnel: Supabase pour tests d'integration
SUPABASE_TEST_URL=${SUPABASE_URL}
SUPABASE_TEST_KEY=${SUPABASE_SERVICE_KEY}
```

---

## 6. Criteres de Succes Phase 0

| Critere | Mesure | Cible |
|---------|--------|-------|
| Infrastructure pytest | `pytest --collect-only` | Exit code 0 |
| Tests de caracterisation | `pytest tests/integration/ -v` | 100% pass |
| Tests unitaires locaux | `pytest tests/unit/ -v` | 100% pass |
| Couverture comportements | Fonctions principales testees | 5+ fonctions |
| Documentation | Ce document a jour | Complet |

---

## 7. Prochaines Etapes (apres Phase 0)

Une fois Phase 0 complete:

1. **Phase 1:** Creer la couche Domain (models, interfaces)
2. **Phase 2:** Implementer les Repositories (Supabase, InMemory, PostgreSQL)
3. **Phase 3:** Migrer les consommateurs vers les abstractions
4. **Phase 4:** Nettoyage et validation finale

---

## 8. Fichiers Obsoletes

Les fichiers suivants sont remplaces par ce document:
- `docs/STRATEGIE_TESTS_CARACTERISATION.md` → A supprimer
- `docs/DECISIONS_TESTS_PHASE0.md` → A supprimer

---

## Annexe: Commandes Utiles

```bash
# Verifier PostgreSQL Docker
docker ps | grep postgres

# Se connecter a PostgreSQL local
docker exec -it mg_postgres psql -U postgres -d archon_test

# Lancer tous les tests
pytest tests/ -v

# Lancer seulement les tests unitaires (rapides)
pytest tests/unit/ -v -m unit

# Lancer seulement les tests d'integration (Supabase)
pytest tests/integration/ -v -m integration

# Verifier la couverture
pytest tests/ -v --cov=archon --cov-report=html
```

---

*Document genere le 2025-11-29*
*Consolide depuis: STRATEGIE_TESTS_CARACTERISATION.md, DECISIONS_TESTS_PHASE0.md*
