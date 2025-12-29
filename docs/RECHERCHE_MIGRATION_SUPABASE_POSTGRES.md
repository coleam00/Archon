# Recherche Stratégique: Migration Supabase vers PostgreSQL

> "Focus. Commitment. Sheer Will." - Document de planification pour la refactorisation de la couche données

---

## Sommaire Exécutif

Ce document présente les résultats de recherche pour la migration de Supabase vers PostgreSQL natif dans le projet Archon. **Bonne nouvelle**: l'architecture actuelle est déjà bien préparée pour cette transition grâce à l'utilisation du Repository Pattern.

---

## 1. Analyse de l'État Actuel du Projet

### 1.1 Fichiers Utilisant Supabase

| Fichier | Rôle | Couplage |
|---------|------|----------|
| `archon/infrastructure/supabase/site_pages_repository.py` | Repository Supabase principal | Fort |
| `archon/infrastructure/supabase/mappers.py` | Mappers de données | Moyen |
| `utils/utils.py` (lignes 402-419) | Initialisation client Supabase | Fort |
| `archon/agent_tools.py` | Outils agent avec fallback legacy | Mixte |
| `archon/container.py` (lignes 77-89) | Injection de dépendances | Faible |
| `streamlit_pages/database.py` | Opérations UI base de données | Moyen |
| `streamlit_pages/documentation.py` | Page UI documentation | Moyen |

### 1.2 Fonctionnalités Supabase Utilisées

- **CRUD Operations**: SELECT, INSERT, DELETE via `.from_()`, `.table()`
- **Vector Search**: RPC `match_site_pages` avec pgvector
- **Filtrage JSONB**: `metadata->>source` pour extraction JSON
- **Authentification**: Service Key uniquement (pas d'auth utilisateur)

### 1.3 Ce Qui N'est PAS Utilisé

- Real-time subscriptions
- Storage (fichiers)
- Edge Functions
- Row Level Security (RLS)
- Auth utilisateur

### 1.4 Architecture Existante (Point Fort!)

```
ISitePagesRepository (Interface)
    |
    +-- SupabaseSitePagesRepository  <-- Actuel
    +-- PostgresSitePagesRepository  <-- DÉJÀ IMPLÉMENTÉ!
    +-- InMemorySitePagesRepository  <-- Tests
```

**Le container supporte déjà le switch via `REPOSITORY_TYPE` env var:**
- `"supabase"` (actuel)
- `"postgres"` (prêt à utiliser)
- `"memory"` (tests)

---

## 2. Stratégies de Migration (Recherche Web)

### 2.1 Approche pg_dump/pg_restore

La méthode officielle recommandée par Supabase:

```bash
# Export depuis Supabase
pg_dump --no-owner --no-acl --schema=public --disable-triggers \
  "postgresql://postgres:[PASSWORD]@db.[PROJECT].supabase.co:5432/postgres" \
  > backup.sql

# Import vers PostgreSQL
psql -h 127.0.0.1 -p 5432 -d postgres -U postgres -f backup.sql
```

**Flags importants:**
- `--no-owner --no-acl`: Exclut les permissions Supabase-spécifiques
- `--schema=public`: Exporte uniquement le schéma public
- `--disable-triggers`: Évite les problèmes de foreign keys circulaires

**Source**: [Migrate your Supabase Database - Medium](https://medium.com/@davidrobertlewis/migrate-your-supabase-database-bc8d6c527e4b)

### 2.2 Performance Tip

> Exécuter la migration depuis une VM cloud dans la même région que la source ou la cible pour optimiser les performances réseau.

**Source**: [Supabase Migration Docs](https://supabase.com/docs/guides/platform/migrating-to-supabase/postgres)

### 2.3 Self-Hosting Options

Pour le self-hosting PostgreSQL, plusieurs options:

| Option | Description |
|--------|-------------|
| Docker | [Self-Hosting with Docker](https://supabase.com/docs/guides/self-hosting/docker) |
| Pigsty | Solution complète avec monitoring, PITR, HA - [Pigsty Supabase](https://pigsty.io/blog/db/supabase/) |
| Coolify | [Guide Coolify + Supabase](https://msof.me/blog/how-to-self-host-supabase-with-coolify-and-migrate-your-project-from-the-official-supabase-platform/) |

---

## 3. Repository Pattern - Best Practices

### 3.1 Pourquoi le Repository Pattern?

Le repository pattern est une abstraction sur le stockage persistant qui:

> "Permet de découpler la couche modèle de la couche données. Il cache les détails ennuyeux de l'accès aux données en prétendant que toutes nos données sont en mémoire."

**Source**: [Cosmic Python - Repository Pattern](https://www.cosmicpython.com/book/chapter_02_repository.html)

### 3.2 Avantages Clés

1. **Séparation des préoccupations** - La couche business ne connaît pas la source de données
2. **Interchangeabilité** - Les repositories sont substituables
3. **Testabilité** - Facilite le mocking et les tests unitaires
4. **Maintenabilité** - Code plus propre à long terme

**Source**: [Repository Pattern with SQLAlchemy - Medium](https://ryan-zheng.medium.com/simplifying-database-interactions-in-python-with-the-repository-pattern-and-sqlalchemy-22baecae8d84)

### 3.3 Pattern Recommandé pour Python/SQLAlchemy

```python
# Interface (Port)
class AbstractRepository(ABC):
    @abstractmethod
    def add(self, entity): ...

    @abstractmethod
    def get(self, id): ...

# Implémentation SQLAlchemy (Adapter)
class SqlAlchemyRepository(AbstractRepository):
    def __init__(self, session):
        self.session = session

    def add(self, entity):
        self.session.add(entity)

    def get(self, id):
        return self.session.query(Model).filter_by(id=id).first()

# Implémentation Fake pour tests
class FakeRepository(AbstractRepository):
    def __init__(self):
        self._data = []
```

**Source**: [DDD in Python - Repository Pattern](https://dddinpython.com/index.php/2022/11/09/implementing-the-repository-pattern-using-sqlalchemy/)

### 3.4 Quand l'Utiliser?

> "Si votre app est un simple wrapper CRUD autour d'une base de données, vous n'avez pas besoin d'un domain model ou d'un repository. Mais plus le domaine est complexe, plus l'investissement dans la libération des préoccupations d'infrastructure sera rentable."

**Source**: [O'Reilly - Architecture Patterns with Python](https://www.oreilly.com/library/view/architecture-patterns-with/9781492052197/ch02.html)

---

## 4. pgvector - Considérations Migration

### 4.1 Compatibilité

pgvector fonctionne identiquement sur Supabase et PostgreSQL natif. C'est une extension PostgreSQL standard.

**Installation sur PostgreSQL natif:**
```sql
CREATE EXTENSION vector;
```

### 4.2 Opérateurs de Similarité

| Opérateur | Description |
|-----------|-------------|
| `<->` | Distance L2 (Euclidienne) |
| `<#>` | Produit scalaire négatif |
| `<=>` | Distance Cosine |

**Exemple de requête:**
```sql
SELECT * FROM site_pages
ORDER BY embedding <=> '[0.1, 0.2, ...]'::vector
LIMIT 5;
```

### 4.3 Index Recommandés

| Type | Avantages | Inconvénients |
|------|-----------|---------------|
| **HNSW** | Meilleur speed-recall tradeoff | Build plus lent, plus de mémoire |
| **IVFFlat** | Build rapide | Nécessite données pour training |

```sql
-- HNSW (recommandé pour la plupart des cas)
CREATE INDEX ON site_pages
USING hnsw (embedding vector_cosine_ops);

-- IVFFlat (si build time est critique)
CREATE INDEX ON site_pages
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);
```

**Source**: [pgvector GitHub](https://github.com/pgvector/pgvector)

### 4.4 Mise à Jour pgvector

```sql
-- Vérifier version actuelle
SELECT extversion FROM pg_extension WHERE extname = 'vector';

-- Mettre à jour
ALTER EXTENSION vector UPDATE;
```

**Source**: [pgvector Tutorial - DataCamp](https://www.datacamp.com/tutorial/pgvector-tutorial)

---

## 5. Défis Identifiés et Solutions

### 5.1 Type ID Mismatch

| Supabase | PostgreSQL |
|----------|------------|
| UUID (`uuid_generate_v4()`) | SERIAL (INTEGER) |

**Solution**: Le script `check_db_schema.py` gère déjà cette migration.

### 5.2 RPC vs SQL Direct

| Supabase | PostgreSQL Direct |
|----------|-------------------|
| `.rpc('match_site_pages', params)` | SQL avec `<=>` operator |

**Solution**: Déjà implémenté dans `PostgresSitePagesRepository`.

### 5.3 Code Legacy Mixte

Fichier `agent_tools.py` contient du code legacy (lignes 100-130) utilisant directement le client Supabase.

**Solution**: Migrer vers l'interface `ISitePagesRepository`.

---

## 6. Plan de Migration Recommandé

### Phase 1: Préparation (Risque: Bas)

- [ ] Vérifier que `PostgresSitePagesRepository` couvre tous les use cases
- [ ] Exécuter les tests avec `REPOSITORY_TYPE=postgres`
- [ ] Documenter les différences de comportement

### Phase 2: Migration Données (Risque: Moyen)

- [ ] Backup complet via `pg_dump`
- [ ] Configurer PostgreSQL local/cloud
- [ ] Installer extension pgvector
- [ ] Importer données via `pg_restore`
- [ ] Créer index HNSW sur colonne embedding

### Phase 3: Switch Code (Risque: Bas)

- [ ] Changer `REPOSITORY_TYPE=postgres` en environnement
- [ ] Tester toutes les fonctionnalités
- [ ] Monitorer performances

### Phase 4: Cleanup (Risque: Très Bas)

- [ ] Supprimer code legacy Supabase dans `agent_tools.py`
- [ ] Mettre à jour Streamlit pages vers interface repository
- [ ] Retirer dépendance `supabase` du `pyproject.toml`
- [ ] Archiver code Supabase (optionnel)

---

## 7. Ressources et Références

### Documentation Officielle
- [Supabase Database Migrations](https://supabase.com/docs/guides/deployment/database-migrations)
- [pgvector GitHub](https://github.com/pgvector/pgvector)
- [Supabase Self-Hosting Docker](https://supabase.com/docs/guides/self-hosting/docker)

### Repository Pattern
- [Cosmic Python - Repository Pattern](https://www.cosmicpython.com/book/chapter_02_repository.html)
- [O'Reilly - Architecture Patterns with Python](https://www.oreilly.com/library/view/architecture-patterns-with/9781492052197/ch02.html)
- [DDD in Python - SQLAlchemy Repository](https://dddinpython.com/index.php/2022/11/09/implementing-the-repository-pattern-using-sqlalchemy/)
- [Medium - Repository Pattern SQLAlchemy](https://ryan-zheng.medium.com/simplifying-database-interactions-in-python-with-the-repository-pattern-and-sqlalchemy-22baecae8d84)

### Migration Guides
- [Migrate Supabase Database - Medium](https://medium.com/@davidrobertlewis/migrate-your-supabase-database-bc8d6c527e4b)
- [Supabase to Self-Hosted Guide](https://ringiq.com/blog/supabase-to-self-hosted-a)
- [Coolify + Supabase Migration](https://msof.me/blog/how-to-self-host-supabase-with-coolify-and-migrate-your-project-from-the-official-supabase-platform/)

### pgvector
- [pgvector Tutorial - DataCamp](https://www.datacamp.com/tutorial/pgvector-tutorial)
- [Vector Similarity Search Deep Dive - Severalnines](https://severalnines.com/blog/vector-similarity-search-with-postgresqls-pgvector-a-deep-dive/)
- [Supabase pgvector Docs](https://supabase.com/docs/guides/database/extensions/pgvector)

---

## 8. Conclusion

Le projet Archon est **bien positionné** pour cette migration grâce à:

1. **Architecture propre** avec Repository Pattern déjà en place
2. **Implémentation PostgreSQL existante** prête à utiliser
3. **Injection de dépendances** permettant le switch via env var
4. **Pas de dépendances Supabase-spécifiques** (auth, realtime, storage)

La migration peut être effectuée de manière **incrémentale et réversible**, minimisant les risques.

---

*Document généré le 29 décembre 2025*
*"People keep asking if I'm back. Yeah, I'm thinking I'm back."*
