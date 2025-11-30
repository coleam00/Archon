# PostgreSQL Backend - Guide d'Activation

## Quick Start

Voici comment activer le backend PostgreSQL pour Archon en 5 étapes simples.

---

## Étape 1: Vérifier les Prérequis

### Base de Données PostgreSQL

Vous avez besoin d'une instance PostgreSQL avec :
- **Version:** PostgreSQL 12+ recommandé
- **Extension:** pgvector installée
- **Accès:** Credentials (host, port, user, password, database)

**Votre configuration actuelle :**
```
Host: localhost
Port: 5432
Database: mydb
User: postgres
Password: postgres
```

---

## Étape 2: Installer les Dépendances Python

```bash
pip install asyncpg>=0.31.0 pgvector>=0.4.1
```

Ou ajoutez à `requirements.txt` :
```txt
asyncpg>=0.31.0
pgvector>=0.4.1
```

---

## Étape 3: Créer le Schema PostgreSQL

### Option A: Script Automatique (Recommandé)

```bash
python migrate_schema.py
```

Ce script va :
- Vérifier la base actuelle
- Créer la table `site_pages` avec le bon schema
- Créer les indexes (url, embedding, metadata->source)

### Option B: SQL Manuel

Exécutez ce SQL dans votre base PostgreSQL :

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

-- Create indexes
CREATE INDEX site_pages_embedding_idx
    ON site_pages
    USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);

CREATE INDEX site_pages_url_idx
    ON site_pages (url);

CREATE INDEX site_pages_metadata_source_idx
    ON site_pages ((metadata->>'source'));
```

---

## Étape 4: Configurer les Variables d'Environnement

Créez un fichier `.env` ou configurez votre environnement :

```bash
# Repository configuration
REPOSITORY_TYPE=postgres

# PostgreSQL connection
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=mydb
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
```

---

## Étape 5: Utiliser le Repository PostgreSQL

### Dans votre code Python

```python
import asyncio
import os
from archon.container import configure, get_repository_async
from archon.domain.models.site_page import SitePage, SitePageMetadata

async def main():
    # Configure environment (si pas dans .env)
    os.environ["REPOSITORY_TYPE"] = "postgres"
    os.environ["POSTGRES_HOST"] = "localhost"
    os.environ["POSTGRES_PORT"] = "5432"
    os.environ["POSTGRES_DB"] = "mydb"
    os.environ["POSTGRES_USER"] = "postgres"
    os.environ["POSTGRES_PASSWORD"] = "postgres"

    # Configure container
    configure(repository_type="postgres")

    # Get repository (async!)
    repo = await get_repository_async()

    # Use the repository
    total = await repo.count()
    print(f"Total pages in database: {total}")

    # Insert a test page
    page = SitePage(
        url="https://test.com/hello",
        chunk_number=0,
        title="Hello PostgreSQL",
        content="Testing the new PostgreSQL backend",
        metadata=SitePageMetadata(source="test"),
    )
    inserted = await repo.insert(page)
    print(f"Inserted page with id: {inserted.id}")

    # Clean up
    await repo.delete_by_source("test")
    await repo.close()

if __name__ == "__main__":
    asyncio.run(main())
```

---

## Vérification

### Tester l'Installation

Exécutez le script de test d'intégration :

```bash
python test_postgres_integration.py
```

Vous devriez voir :
```
[SUCCESS] ALL TESTS PASSED!
```

### Tester les Unit Tests

```bash
pytest tests/infrastructure/test_postgres_repository.py -v
```

Attendu : **16/16 tests passed**

---

## Points Importants

### ⚠️ Utiliser `get_repository_async()`

Le backend PostgreSQL nécessite une initialisation asynchrone :

```python
# ✅ CORRECT
from archon.container import get_repository_async
repo = await get_repository_async()

# ❌ INCORRECT (lance une erreur)
from archon.container import get_repository
repo = get_repository()  # RuntimeError!
```

### 🔒 Fermer le Repository

N'oubliez pas de fermer le pool de connexions :

```python
await repo.close()
```

Ou utilisez un context manager (futur enhancement).

### 🚀 Performance

Le backend PostgreSQL offre :
- **Connection pooling** : 5-20 connexions réutilisées
- **Recherche vectorielle native** : pgvector IVFFlat index
- **Batch operations** : Transactions pour insert_batch

---

## Comparaison avec Supabase

| Feature | Supabase | PostgreSQL |
|---------|----------|------------|
| Setup | Facile (cloud) | Moyen (self-host) |
| Performance | Moyen | **Élevé** |
| Coût | Payant (tiers gratuit limité) | **Gratuit** |
| Contrôle | Limité (API) | **Total (SQL)** |
| Auth | Intégré | PostgreSQL users |

**Recommandation :**
- **Développement local** : PostgreSQL (pas de cloud requis)
- **Production** : PostgreSQL (meilleur coût/performance)
- **Prototypage rapide** : Supabase (setup instantané)

---

## Migration depuis Supabase

Si vous utilisez déjà Supabase et voulez migrer :

### 1. Exporter les Données

```bash
# Depuis Supabase dashboard ou CLI
supabase db dump --file backup.sql
```

### 2. Créer le Schema PostgreSQL

```bash
python migrate_schema.py
```

### 3. Importer les Données

```bash
psql -h localhost -U postgres -d mydb -f backup.sql
```

### 4. Mettre à Jour la Configuration

```bash
# Avant
REPOSITORY_TYPE=supabase

# Après
REPOSITORY_TYPE=postgres
```

### 5. Mettre à Jour le Code

```python
# Avant (Supabase)
repo = get_repository()

# Après (PostgreSQL)
repo = await get_repository_async()
```

---

## Troubleshooting

### Erreur: "Connection refused"

**Cause :** PostgreSQL n'est pas accessible

**Solution :**
```bash
# Vérifier que PostgreSQL tourne
docker ps | grep postgres

# Tester la connexion
psql -h localhost -U postgres -d mydb
```

### Erreur: "relation site_pages does not exist"

**Cause :** Schema pas créé

**Solution :**
```bash
python migrate_schema.py
```

### Erreur: "This event loop is already running"

**Cause :** Utilisation de `get_repository()` au lieu de `get_repository_async()`

**Solution :**
```python
repo = await get_repository_async()  # Pas get_repository()!
```

### Warning: "Vector search returns few results"

**Cause :** IVFFlat index avec peu de vecteurs (< 1000)

**Solution :** C'est normal. L'index approximatif fonctionne mieux avec beaucoup de données.

---

## Support et Documentation

### Documentation Complète

Voir `docs/POSTGRES_BACKEND.md` pour :
- Architecture détaillée
- Performance tuning
- Query optimization
- Advanced usage

### Rapport d'Implémentation

Voir `POSTGRES_BACKEND_REPORT.md` pour :
- Détails techniques
- Résultats des tests
- Comparaisons de performance

### Aide

Si vous rencontrez des problèmes :
1. Vérifier les logs (`workbench/logs.txt`)
2. Tester avec `test_postgres_integration.py`
3. Vérifier les variables d'environnement
4. Consulter la documentation

---

## Exemple Complet

```python
"""
Exemple complet d'utilisation du backend PostgreSQL.
"""
import asyncio
import os
from archon.container import configure, get_repository_async
from archon.domain.models.site_page import SitePage, SitePageMetadata

async def demo():
    # 1. Configuration
    os.environ.update({
        "REPOSITORY_TYPE": "postgres",
        "POSTGRES_HOST": "localhost",
        "POSTGRES_PORT": "5432",
        "POSTGRES_DB": "mydb",
        "POSTGRES_USER": "postgres",
        "POSTGRES_PASSWORD": "postgres",
    })
    configure(repository_type="postgres")

    # 2. Obtenir le repository
    repo = await get_repository_async()
    print("✓ Repository connected")

    # 3. Compter les pages existantes
    total = await repo.count()
    print(f"✓ Total pages: {total}")

    # 4. Insérer des pages
    pages = [
        SitePage(
            url=f"https://example.com/page{i}",
            chunk_number=0,
            title=f"Page {i}",
            content=f"Content for page {i}",
            metadata=SitePageMetadata(source="demo"),
            embedding=[0.1 * i] * 1536,
        )
        for i in range(1, 4)
    ]
    inserted = await repo.insert_batch(pages)
    print(f"✓ Inserted {len(inserted)} pages")

    # 5. Rechercher par similarité
    results = await repo.search_similar([0.1] * 1536, limit=3)
    print(f"✓ Found {len(results)} similar pages:")
    for i, result in enumerate(results, 1):
        print(f"  {i}. {result.page.title} (similarity: {result.similarity:.3f})")

    # 6. Lister les URLs
    urls = await repo.list_unique_urls(source="demo")
    print(f"✓ Unique URLs: {len(urls)}")

    # 7. Nettoyer
    deleted = await repo.delete_by_source("demo")
    print(f"✓ Deleted {deleted} demo pages")

    # 8. Fermer la connexion
    await repo.close()
    print("✓ Repository closed")

if __name__ == "__main__":
    asyncio.run(demo())
```

---

**Status:** ✅ Backend PostgreSQL opérationnel et testé

**Version:** 1.0.0 (2025-11-30)

**Next Steps:**
- Tester en production
- Monitorer les performances
- Considérer SQLAlchemy backend pour multi-DB support
