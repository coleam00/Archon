# Guide de Dépréciation Supabase

> Documentation de tout le code legacy Supabase qui peut être nettoyé après migration complète vers PostgreSQL

---

## Statut actuel

**Date**: 2025-12-29
**Situation**: PostgreSQL est maintenant le backend par défaut et recommandé. Supabase reste supporté comme fallback pour rétro-compatibilité.

**IMPORTANT**: Ce guide documente ce qui PEUT être nettoyé. **Ne rien supprimer sans l'accord explicite de l'utilisateur** car certains projets peuvent encore dépendre de Supabase.

---

## Table des matières

1. [Code à nettoyer](#code-à-nettoyer)
2. [Variables d'environnement](#variables-denvironnement)
3. [Dépendances](#dépendances)
4. [Fichiers SQL](#fichiers-sql)
5. [Tests](#tests)
6. [Plan de migration](#plan-de-migration)
7. [Checklist de nettoyage](#checklist-de-nettoyage)

---

## Code à nettoyer

### 1. archon/agent_tools.py

**Lignes concernées**: 49, 59, 101-102, 127, 134, 143, 156-158, 170, 177, 185, 214-216, 238

#### Fonction: `search_documentation()`

**Code legacy (lignes 49-127)**:
```python
async def search_documentation(
    query: str,
    match_count: int = 5,
    repository: Optional[ISitePagesRepository] = None,
    embedding_service: Optional[IEmbeddingService] = None,
    supabase: Optional[Any] = None,  # Legacy fallback (deprecated)
):
    """
    Search the documentation for relevant content.

    Args:
        query: Search query
        match_count: Maximum number of results
        repository: (Preferred) ISitePagesRepository implementation
        embedding_service: (Preferred) IEmbeddingService implementation
        supabase: (Legacy) Supabase client

    Returns:
        List of search results with similarity scores
    """
    # Preferred: use repository pattern
    if repository is not None and embedding_service is not None:
        try:
            query_embedding = await embedding_service.get_embedding(query)
            results = await repository.search_similar(
                query_embedding, limit=match_count
            )
            return [
                {
                    "url": r.page.url,
                    "title": r.page.title or "",
                    "summary": r.page.summary or "",
                    "content": r.page.content or "",
                    "chunk_number": r.page.chunk_number,
                    "similarity": r.similarity,
                }
                for r in results
            ]
        except Exception as e:
            logging.error(f"Error searching documentation with repository: {e}")
            raise

    # Legacy: fallback to Supabase client (deprecated)
    if supabase is not None:
        result = supabase.rpc(
            "search_documentation",
            {
                "query_embedding": embedding,
                "match_count": match_count,
            },
        ).execute()
        # ... (code legacy)

    raise ValueError("Either repository or supabase must be provided")
```

**Action recommandée**:
- Supprimer le paramètre `supabase: Optional[Any] = None`
- Supprimer le bloc `if supabase is not None:` (lignes 101-125)
- Supprimer le `raise ValueError` final et le remplacer par une erreur plus claire si repository/embedding_service manquent
- Renommer la fonction en `search_documentation_async()` pour clarifier qu'elle est async

**Code nettoyé proposé**:
```python
async def search_documentation(
    query: str,
    match_count: int = 5,
    repository: Optional[ISitePagesRepository] = None,
    embedding_service: Optional[IEmbeddingService] = None,
):
    """
    Search the documentation for relevant content using repository pattern.

    Args:
        query: Search query
        match_count: Maximum number of results
        repository: ISitePagesRepository implementation
        embedding_service: IEmbeddingService implementation

    Returns:
        List of search results with similarity scores

    Raises:
        ValueError: If repository or embedding_service is None
    """
    if repository is None or embedding_service is None:
        raise ValueError("Both repository and embedding_service are required")

    try:
        query_embedding = await embedding_service.get_embedding(query)
        results = await repository.search_similar(
            query_embedding, limit=match_count
        )
        return [
            {
                "url": r.page.url,
                "title": r.page.title or "",
                "summary": r.page.summary or "",
                "content": r.page.content or "",
                "chunk_number": r.page.chunk_number,
                "similarity": r.similarity,
            }
            for r in results
        ]
    except Exception as e:
        logging.error(f"Error searching documentation: {e}")
        raise
```

#### Fonction: `list_documentation_pages()`

**Code legacy (lignes 134-170)**:
Similaire à `search_documentation()`, avec un fallback Supabase.

**Action recommandée**:
- Supprimer le paramètre `supabase: Optional[Any] = None`
- Supprimer le bloc `if supabase is not None:` (lignes 156-168)
- Simplifier la logique

#### Fonction: `get_or_create_page()`

**Code legacy (lignes 177-238)**:
Similaire aux deux précédentes.

**Action recommandée**:
- Supprimer le paramètre `supabase: Optional[Any] = None`
- Supprimer le bloc `if supabase is not None:` (lignes 214-236)
- Simplifier la logique

**Estimation**: ~90 lignes de code à supprimer dans `archon/agent_tools.py`

---

### 2. streamlit_pages/database.py

**Lignes concernées**: 17-33, 40-42, 62, 66, 73, 118-128, 192-205

#### Fonction: `get_supabase_sql_editor_url()`

**Code legacy (lignes 17-33)**:
```python
def get_supabase_sql_editor_url(supabase_url):
    """Generate the Supabase SQL editor URL from the project URL."""
    try:
        # Format is typically: https://<project-ref>.supabase.co
        if '//' in supabase_url and 'supabase' in supabase_url:
            parts = supabase_url.split('//')
            if len(parts) > 1:
                domain_parts = parts[1].split('.')
                if len(domain_parts) > 0:
                    project_ref = domain_parts[0]
                    return f"https://supabase.com/dashboard/project/{project_ref}/sql/new"

        return "https://supabase.com/dashboard"
    except:
        return "https://supabase.com/dashboard"
```

**Action recommandée**: Supprimer cette fonction entièrement (plus nécessaire avec PostgreSQL).

#### Fonction: `database_tab()`

**Paramètre legacy (ligne 62)**:
```python
def database_tab(supabase, repository: Optional[ISitePagesRepository] = None):
```

**Code legacy dans la fonction**:
- Lignes 73: `if not supabase:`
- Lignes 118-128: Appels directs `supabase.table("site_pages")`
- Lignes 192-205: Bouton "Clear All Data" avec `supabase.table("site_pages").delete()`

**Action recommandée**:
- Supprimer le paramètre `supabase`
- Remplacer tous les appels `supabase.table(...)` par des appels au repository
- Supprimer les références à `get_supabase_sql_editor_url()`

**Estimation**: ~50 lignes de code à supprimer/modifier dans `streamlit_pages/database.py`

---

### 3. streamlit_pages/documentation.py

**Lignes concernées**: 13, 17, 41-42, 44, 161, 170, 175, 180, 189

#### Fonction: `documentation_tab()`

**Paramètre legacy (ligne 13)**:
```python
def documentation_tab(supabase_client, repository: Optional[ISitePagesRepository] = None):
```

**Code legacy dans la fonction**:
- Lignes 41-44: Vérification des variables `SUPABASE_URL` et `SUPABASE_SERVICE_KEY`
- Lignes 161-189: Appels directs `supabase_client.table("site_pages")`

**Action recommandée**:
- Supprimer le paramètre `supabase_client`
- Supprimer les vérifications de `SUPABASE_URL` et `SUPABASE_SERVICE_KEY`
- Remplacer tous les appels `supabase_client.table(...)` par des appels au repository

**Estimation**: ~40 lignes de code à supprimer/modifier dans `streamlit_pages/documentation.py`

---

### 4. utils/utils.py

**Lignes concernées**: 1, 402-433

#### Import Supabase (ligne 1):
```python
from supabase import Client, create_client
```

**Action recommandée**: Supprimer cet import.

#### Fonction: `get_supabase_client()`

**Code legacy (lignes 402-416)**:
```python
def get_supabase_client() -> Optional[Client]:
    """
    Get configured Supabase client from environment variables.

    Returns:
        Supabase client if credentials are available, None otherwise
    """
    supabase_url = get_env_var("SUPABASE_URL")
    supabase_key = get_env_var("SUPABASE_SERVICE_KEY")

    if supabase_url and supabase_key:
        try:
            return Client(supabase_url, supabase_key)
        except Exception as e:
            logger.error(f"Error creating Supabase client: {e}")

    return None
```

**Action recommandée**: Supprimer cette fonction entièrement.

#### Fonction: `get_clients()` (deprecated)

**Code legacy (lignes 418-433)**:
```python
def get_clients():
    """
    Get all required clients for Archon.

    DEPRECATED: Prefer using get_openai_client() and get_supabase_client() individually,
    or better yet, use the dependency injection container (archon.container).

    Returns:
        Tuple of (openai_client, supabase_client)
    """
    embedding_client = get_openai_client()
    supabase = get_supabase_client()
    return embedding_client, supabase
```

**Action recommandée**: Supprimer cette fonction entièrement (déjà marquée deprecated).

**Estimation**: ~35 lignes de code à supprimer dans `utils/utils.py`

---

### 5. archon/container.py

**Lignes concernées**: 79-91

#### Support Supabase dans `get_repository()`

**Code legacy (lignes 79-91)**:
```python
if repo_type == "supabase":
    # Import lazy pour eviter les dependances circulaires
    from utils.utils import get_supabase_client
    from archon.infrastructure.supabase import SupabaseSitePagesRepository

    supabase_client = get_supabase_client()
    if supabase_client is None:
        raise ValueError(
            "Supabase client not available. "
            "Please configure SUPABASE_URL and SUPABASE_SERVICE_KEY in environment."
        )
    _repository_instance = SupabaseSitePagesRepository(supabase_client)
    logger.info("Created SupabaseSitePagesRepository instance")
```

**Action recommandée**:
- **Option 1 (conservatrice)**: Garder ce code mais ajouter un warning de dépréciation
- **Option 2 (agressive)**: Supprimer complètement le support Supabase

**Recommandation**: Option 1 - garder le support avec warning pendant au moins 6 mois.

---

### 6. archon/infrastructure/supabase/

**Fichiers concernés**:
- `archon/infrastructure/supabase/__init__.py`
- `archon/infrastructure/supabase/site_pages_repository.py`
- `archon/infrastructure/supabase/mappers.py`

**Action recommandée**:
- **Option 1**: Déplacer dans un dossier `archon/infrastructure/_deprecated/supabase/`
- **Option 2**: Supprimer complètement

**Recommandation**: Option 1 - marquer comme deprecated mais garder pendant 6 mois pour compatibilité.

---

## Variables d'environnement

### Fichiers concernés

- `.env.example` (lignes 21-28)
- `workbench/env_vars.json` (si présent)

### Variables Supabase à documenter

```bash
# .env.example (lignes 21-28)
# Get your SUPABASE_URL from the API section of your Supabase project settings -
# https://supabase.com/dashboard/project/<your-project-id>/settings/api
SUPABASE_URL=

# Get your SUPABASE_SERVICE_KEY from the API section of your Supabase project settings -
# https://supabase.com/dashboard/project/<your-project-id>/settings/api
# This is the 'service_role' key - keep it secret!
SUPABASE_SERVICE_KEY=
```

### Action recommandée

**Option 1 (conservatrice)**:
- Garder les variables dans `.env.example` mais les marquer comme `# DEPRECATED`
- Ajouter un commentaire expliquant la migration vers PostgreSQL

**Option 2 (agressive)**:
- Supprimer les variables de `.env.example`
- Créer un fichier `.env.example.supabase` pour ceux qui en ont encore besoin

**Exemple de code nettoyé (.env.example)**:
```bash
# --- DEPRECATED: Supabase (legacy backend) ---
# IMPORTANT: PostgreSQL is now the recommended backend.
# These variables are only needed if you're still using Supabase.
# See docs/SUPABASE_DEPRECATION_GUIDE.md for migration instructions.
# SUPABASE_URL=
# SUPABASE_SERVICE_KEY=

# --- PostgreSQL (recommended) ---
REPOSITORY_TYPE=postgres
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
POSTGRES_DB=archon
POSTGRES_USER=postgres
POSTGRES_PASSWORD=your_password
```

---

## Dépendances

### requirements.txt

**Ligne concernée**: 150

```
supabase==2.11.0
```

### Action recommandée

**Option 1 (conservatrice)**:
- Garder `supabase` dans `requirements.txt` mais le rendre optionnel
- Créer `requirements-minimal.txt` sans Supabase

**Option 2 (agressive)**:
- Supprimer `supabase==2.11.0` de `requirements.txt`
- Créer `requirements-supabase.txt` pour ceux qui en ont besoin

**Exemple de code nettoyé (requirements.txt)**:
```
# Core dependencies
pydantic==2.10.5
pydantic-ai==0.0.15
# ... autres dépendances ...

# Database - PostgreSQL (recommended)
asyncpg==0.30.0
psycopg2-binary==2.9.10

# Database - Supabase (legacy, optional)
# supabase==2.11.0  # Uncomment if you need Supabase support
```

**Fichier séparé (requirements-supabase.txt)**:
```
# Legacy Supabase support
# Install with: pip install -r requirements-supabase.txt
supabase==2.11.0
```

---

## Fichiers SQL

### Fichiers concernés

- `utils/site_pages.sql` - Schema Supabase avec RPC functions

**Contenu du fichier**:
- Définition de table `site_pages` pour Supabase
- Fonction RPC `search_documentation` pour vector search
- Index vectoriel `site_pages_embedding_idx`

### Action recommandée

**Option 1 (conservatrice)**:
- Renommer en `utils/site_pages.supabase.sql`
- Créer `utils/site_pages.postgres.sql` pour le nouveau schema (si pas déjà fait)

**Option 2 (agressive)**:
- Supprimer `utils/site_pages.sql`
- Garder uniquement le schema PostgreSQL

**Recommandation**: Option 1 - renommer pour clarifier que c'est le schema Supabase legacy.

---

## Tests

### Fichiers concernés

Aucun test ne dépend directement de Supabase car:
- Les tests d'intégration utilisent le repository pattern
- Les tests unitaires utilisent `InMemoryRepository`

**Action recommandée**: Aucune modification nécessaire dans les tests.

---

## Plan de migration

### Phase 1: Documentation et warning (ACTUEL)

**Status**: EN COURS

**Actions**:
- [x] Créer ce guide de dépréciation
- [ ] Ajouter des warnings dans le code Supabase:
  ```python
  import warnings
  warnings.warn(
      "Supabase backend is deprecated and will be removed in v7.0. "
      "Please migrate to PostgreSQL. See docs/SUPABASE_DEPRECATION_GUIDE.md",
      DeprecationWarning
  )
  ```
- [ ] Mettre à jour README.md avec un avertissement clair

### Phase 2: Rendre Supabase optionnel (v6.1 - dans 1 mois)

**Actions**:
- [ ] Déplacer `supabase` vers dépendances optionnelles
- [ ] Modifier `.env.example` pour marquer Supabase comme deprecated
- [ ] Ajouter des guards dans le code pour gérer l'absence de Supabase
- [ ] Créer `requirements-supabase.txt` séparé

### Phase 3: Dépréciation complète (v6.5 - dans 3 mois)

**Actions**:
- [ ] Déplacer `archon/infrastructure/supabase/` vers `_deprecated/`
- [ ] Supprimer le support Supabase de `archon/container.py`
- [ ] Mettre à jour tous les exemples pour utiliser PostgreSQL uniquement

### Phase 4: Suppression (v7.0 - dans 6 mois)

**Actions**:
- [ ] Supprimer tout le code Supabase
- [ ] Supprimer la dépendance `supabase` de requirements
- [ ] Supprimer les variables d'environnement Supabase
- [ ] Nettoyer les fichiers SQL legacy

---

## Checklist de nettoyage

Utilisez cette checklist quand vous décidez de nettoyer le code Supabase.

### Avant de commencer

- [ ] Confirmer que tous les utilisateurs ont migré vers PostgreSQL
- [ ] Sauvegarder toutes les données Supabase si nécessaire
- [ ] Tester l'application complète avec PostgreSQL
- [ ] Créer une branche git dédiée: `cleanup/remove-supabase`

### Code à supprimer

#### archon/agent_tools.py
- [ ] Supprimer paramètre `supabase` dans `search_documentation()`
- [ ] Supprimer paramètre `supabase` dans `list_documentation_pages()`
- [ ] Supprimer paramètre `supabase` dans `get_or_create_page()`
- [ ] Supprimer tous les blocs `if supabase is not None:`

#### streamlit_pages/database.py
- [ ] Supprimer fonction `get_supabase_sql_editor_url()`
- [ ] Supprimer paramètre `supabase` dans `database_tab()`
- [ ] Remplacer tous les appels `supabase.table(...)` par repository

#### streamlit_pages/documentation.py
- [ ] Supprimer paramètre `supabase_client` dans `documentation_tab()`
- [ ] Remplacer tous les appels `supabase_client.table(...)` par repository
- [ ] Supprimer vérifications de `SUPABASE_URL` et `SUPABASE_SERVICE_KEY`

#### utils/utils.py
- [ ] Supprimer `from supabase import Client, create_client`
- [ ] Supprimer fonction `get_supabase_client()`
- [ ] Supprimer fonction `get_clients()` (deprecated)

#### archon/container.py
- [ ] Supprimer bloc `if repo_type == "supabase":` dans `get_repository()`
- [ ] Supprimer import `from archon.infrastructure.supabase`

#### archon/infrastructure/
- [ ] Supprimer dossier `archon/infrastructure/supabase/` complet

### Variables d'environnement

#### .env.example
- [ ] Supprimer ou commenter `SUPABASE_URL`
- [ ] Supprimer ou commenter `SUPABASE_SERVICE_KEY`
- [ ] Vérifier que PostgreSQL est bien documenté comme backend par défaut

#### workbench/env_vars.json (si présent)
- [ ] Supprimer les clés Supabase stockées

### Dépendances

#### requirements.txt
- [ ] Supprimer `supabase==2.11.0`

#### Optionnel
- [ ] Créer `requirements-supabase.txt` pour rétro-compatibilité temporaire

### Fichiers SQL

#### utils/
- [ ] Renommer `site_pages.sql` en `site_pages.supabase.sql` (ou supprimer)
- [ ] Vérifier que `site_pages.postgres.sql` existe et est à jour

### Documentation

#### README.md
- [ ] Supprimer les références à Supabase
- [ ] Mettre à jour les instructions de setup pour PostgreSQL uniquement

#### docs/ARCHITECTURE.md
- [ ] Mettre à jour la section backends pour retirer Supabase
- [ ] Ajouter une note historique si nécessaire

### Tests et validation

#### Tests
- [ ] Exécuter tous les tests: `pytest -v`
- [ ] Vérifier que tous les tests passent sans Supabase
- [ ] Tester l'application complète en local

#### Application
- [ ] Vérifier le crawling de documentation
- [ ] Vérifier la recherche vectorielle
- [ ] Vérifier l'interface Streamlit
- [ ] Tester la création d'un agent complet

### Git et déploiement

- [ ] Commit tous les changements: `git commit -m "feat: Remove Supabase legacy code"`
- [ ] Créer une Pull Request avec description détaillée
- [ ] Faire une review complète
- [ ] Merger dans main
- [ ] Créer un tag de version: `git tag v7.0.0`
- [ ] Mettre à jour le CHANGELOG

---

## Estimation globale

### Lignes de code à supprimer/modifier

| Fichier | Lignes à supprimer | Lignes à modifier | Total |
|---------|-------------------|------------------|-------|
| `archon/agent_tools.py` | ~90 | ~10 | ~100 |
| `streamlit_pages/database.py` | ~50 | ~20 | ~70 |
| `streamlit_pages/documentation.py` | ~40 | ~15 | ~55 |
| `utils/utils.py` | ~35 | ~5 | ~40 |
| `archon/container.py` | ~15 | ~5 | ~20 |
| `archon/infrastructure/supabase/` | ~300 (tout le dossier) | 0 | ~300 |
| **TOTAL** | **~530** | **~55** | **~585** |

### Temps estimé

- **Préparation et tests**: 2-3 heures
- **Modifications du code**: 3-4 heures
- **Tests et validation**: 2-3 heures
- **Documentation et review**: 1-2 heures

**Total**: 8-12 heures de travail pour un cleanup complet.

---

## Risques et précautions

### Risques identifiés

1. **Utilisateurs existants**: Certains projets peuvent encore utiliser Supabase
2. **Données perdues**: Migration non complète des données Supabase → PostgreSQL
3. **Compatibilité**: Code tiers qui dépend de Supabase
4. **Rollback difficile**: Une fois le code supprimé, retour en arrière coûteux

### Précautions recommandées

1. **Communication claire**:
   - Avertir dans les release notes
   - Créer un guide de migration complet
   - Donner un délai suffisant (6 mois minimum)

2. **Support progressif**:
   - Phase 1: Warning de dépréciation
   - Phase 2: Dépendance optionnelle
   - Phase 3: Code déplacé vers `_deprecated/`
   - Phase 4: Suppression complète

3. **Tests exhaustifs**:
   - Tests d'intégration avec PostgreSQL
   - Validation manuelle de tous les workflows
   - Tests de performance

4. **Backup et rollback**:
   - Garder une branche `supabase-legacy` au cas où
   - Documenter la procédure de rollback
   - Tester le rollback avant la suppression définitive

---

## Support et migration

### Aide à la migration Supabase → PostgreSQL

Pour les utilisateurs qui ont encore Supabase, voir:
- [docs/MIGRATION_POSTGRES.md](MIGRATION_POSTGRES.md) - Guide complet de migration
- [docs/ARCHITECTURE.md](ARCHITECTURE.md) - Architecture du nouveau système

### Questions fréquentes

**Q: Puis-je continuer à utiliser Supabase?**
R: Oui, jusqu'à la version 7.0. Mais nous recommandons fortement de migrer vers PostgreSQL.

**Q: Comment migrer mes données Supabase vers PostgreSQL?**
R: Voir le guide [docs/MIGRATION_POSTGRES.md](MIGRATION_POSTGRES.md).

**Q: Le code Supabase sera-t-il complètement supprimé?**
R: Oui, dans la version 7.0 (estimée dans 6 mois). Une période de transition de 6 mois est prévue.

**Q: Que faire si je rencontre des problèmes après la migration?**
R: Créer une issue GitHub avec le tag `migration` et fournir les logs détaillés.

---

## Historique des modifications

| Date | Version | Description |
|------|---------|-------------|
| 2025-12-29 | 1.0 | Création initiale du guide de dépréciation |
| TBD | 1.1 | Mise à jour après Phase 1 (warnings) |
| TBD | 2.0 | Mise à jour après Phase 2 (optionnel) |
| TBD | 3.0 | Mise à jour après Phase 3 (deprecated/) |
| TBD | 4.0 | Documentation finale après suppression complète |

---

**Maintenu par**: Archon Team
**Contact**: GitHub Issues
**Dernière révision**: 2025-12-29
