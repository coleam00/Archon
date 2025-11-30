# Context: DB Staging Setup Agent

## Session Summary (2024-11-30)

Ce document permet de reprendre le travail sur le staging PostgreSQL après un redémarrage.

## État Actuel : PRÊT À LANCER

### Ce qui a été fait

| Étape | Status | Détails |
|-------|--------|---------|
| Backend PostgreSQL | ✅ Validé | 16/16 tests passent |
| Container PostgreSQL | ✅ Running | `mg_postgres` sur 5432 |
| `.env.staging` | ✅ Créé | Avec clé API OpenAI |
| `Dockerfile.staging` | ✅ Créé | Ports 8502/8101 |
| `run_staging.py` | ✅ Créé | Script de lancement |
| `graph_service.py` | ✅ Modifié | Support `GRAPH_SERVICE_PORT` |
| `archon/container.py` | ✅ Modifié | Support `REPOSITORY_TYPE` |

### Ce qu'il reste à faire

| Étape | Status | Commande |
|-------|--------|----------|
| Lancer staging | ⏳ En attente | `python run_staging.py` |
| Valider UI | ⏳ En attente | http://localhost:8502 |
| Valider API | ⏳ En attente | http://localhost:8101/health |
| Tester crawl | ⏳ En attente | Via UI Streamlit |
| Vérifier données PostgreSQL | ⏳ En attente | Voir commande ci-dessous |

## Architecture

```
PRODUCTION (Actuelle)              STAGING (Nouvelle)
=====================              ==================
Port UI:      8501                 Port UI:      8502
Port API:     8100                 Port API:     8101
Database:     Supabase             Database:     PostgreSQL
Container:    archon-container     Container:    archon-staging
Status:       En ligne             Status:       Prêt à lancer
```

## Commandes Rapides

### Lancer le staging
```bash
cd D:\archon\archon
python run_staging.py
```

### Vérifier le status
```bash
# Container
docker ps --filter "name=archon-staging"

# Logs
docker logs archon-staging -f

# Health check
curl http://localhost:8101/health
```

### Vérifier les données PostgreSQL
```bash
docker exec -it mg_postgres psql -U postgres -d mydb -c "SELECT COUNT(*) FROM site_pages;"
```

### Arrêter le staging
```bash
docker stop archon-staging && docker rm archon-staging
```

## Fichiers Créés

| Fichier | Chemin | Description |
|---------|--------|-------------|
| Config env | `D:\archon\archon\.env.staging` | Variables d'environnement avec API keys |
| Dockerfile | `D:\archon\archon\Dockerfile.staging` | Image Docker staging |
| Script | `D:\archon\archon\run_staging.py` | Script de lancement |
| Agent | `D:\archon\archon\.claude\agents\db-staging-setup-agent.md` | Définition agent |
| Context | `D:\archon\archon\docs\CONTEXT_STAGING_SETUP.md` | Documentation complète |

## Modifications de Code

### `graph_service.py` (lignes 68-73)
```python
if __name__ == "__main__":
    import uvicorn
    import os
    port = int(os.environ.get("GRAPH_SERVICE_PORT", "8100"))
    host = os.environ.get("GRAPH_SERVICE_HOST", "0.0.0.0")
    uvicorn.run(app, host=host, port=port)
```

### `archon/container.py` (lignes 24-30)
```python
import os

# Configuration globale - permet override via variable d'environnement
_default_repo_type = os.environ.get("REPOSITORY_TYPE", "supabase")

_config = {
    "repository_type": _default_repo_type,  # "supabase" | "postgres" | "memory"
    "embedding_type": "openai",              # "openai" | "mock"
}
```

## Configuration `.env.staging`

```bash
REPOSITORY_TYPE=postgres
POSTGRES_HOST=host.docker.internal
POSTGRES_PORT=5432
POSTGRES_DB=mydb
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
GRAPH_SERVICE_PORT=8101
LLM_PROVIDER=OpenAI
PRIMARY_MODEL=gpt-4o-mini
# API keys configurées
```

## Checklist de Validation (après lancement)

### Phase 1: Container
- [ ] `archon-staging` visible dans `docker ps`
- [ ] Status "Up"
- [ ] Ports 8502:8502 et 8101:8101 mappés

### Phase 2: Services
- [ ] http://localhost:8502 charge l'UI Streamlit
- [ ] http://localhost:8101/health retourne `{"status": "ok"}`

### Phase 3: Backend PostgreSQL
- [ ] Page Environment montre config PostgreSQL
- [ ] Crawl d'une doc fonctionne
- [ ] Données visibles dans PostgreSQL

### Phase 4: Production intacte
- [ ] http://localhost:8501 fonctionne toujours
- [ ] http://localhost:8100/health répond

## Troubleshooting

### Container ne démarre pas
```bash
docker logs archon-staging
```

### PostgreSQL non accessible
```bash
docker ps | findstr mg_postgres
docker start mg_postgres  # si arrêté
```

### Données dans Supabase au lieu de PostgreSQL
```bash
docker exec archon-staging env | grep REPOSITORY_TYPE
# Doit afficher: REPOSITORY_TYPE=postgres
```

## Historique des Sessions

### Session 1 (2024-11-30)
- Exploration de la configuration Archon
- Création des fichiers staging
- Modification du code pour support env vars
- Agent et contexte créés
- **Prochaine action**: Lancer `python run_staging.py`

---

## Pour Reprendre

Après redémarrage, dis simplement :
- "Lance le staging PostgreSQL"
- "Démarre l'instance staging"
- "Continue le setup staging"

L'agent `db-staging-setup-agent` a toutes les informations nécessaires.

---

## Annexe: Agent Definition

Voir fichier complet: `.claude/agents/db-staging-setup-agent.md`
