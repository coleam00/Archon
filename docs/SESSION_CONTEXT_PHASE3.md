# Contexte de Session - Phase 3: Migration
**Date de creation**: 2025-11-30
**Projet Archon ID**: `3fa4190a-4cfe-4b6e-b977-1cc49aa34d55`

---

## Etat Actuel du Projet

### Phases Completees

| Phase | Statut | Description | Commit |
|-------|--------|-------------|--------|
| Phase 0 | Done | Infrastructure de tests, tests de caracterisation | - |
| Phase 1 | Done | Domain Layer (modeles Pydantic, interfaces ABC) | `80e3c47` |
| Phase 2 | Done | Infrastructure Layer (Supabase, Memory, OpenAI) | `80e3c47` |
| Phase 2.5 | Done | Validation et consolidation | `80e3c47` |

### Phase 3 - En Cours

| Etape | Fichier | Statut | Task ID |
|-------|---------|--------|---------|
| 1 | `archon/container.py` | Todo | `1c3b0f97-1890-4258-a175-47f46b75c85e` |
| 2 | `archon/agent_tools.py` | Todo | `a72e4139-a10b-4d17-b8e2-4b5c4be301d1` |
| 3 | `crawl_pydantic_ai_docs.py` | Todo | `e677ae19-20c1-4acd-b5c8-8a16ba753676` |
| 4 | `streamlit_pages/database.py` | Todo | `ed92861d-0378-443a-aa44-db17ed35add9` |
| 5 | `streamlit_pages/documentation.py` | Todo | (meme tache) |
| 6 | `archon/pydantic_ai_coder.py` | Todo | `9c0ef157-ece4-4c42-8ffa-2c25c14c43e9` |
| 7 | `archon/refiner_agents/*.py` | Todo | (meme tache) |

---

## Agent de Migration

**Agent**: `db-refactor-migration-agent`
**Fichier**: `.claude/agents/db-refactor-migration-agent.md`

### Regles Critiques de l'Agent

1. **JAMAIS casser le code existant**
2. **UN fichier a la fois**
3. **Tests apres CHAQUE migration**
4. **Commit apres CHAQUE succes**
5. **Mode "dual" si necessaire** (ancien + nouveau code)

### Workflow de l'Agent

```
ANALYSER -> PLANIFIER -> IMPLEMENTER -> TESTER -> VALIDER -> COMMIT -> RAPPORT
```

---

## Fichiers Crees pour Phase 3

### Nouveau
```
archon/container.py                          # A CREER - DI Container
archon/infrastructure/memory/mock_embedding_service.py  # CREE - Mock pour tests
```

### Documentation
```
.claude/agents/db-refactor-migration-agent.md  # CREE - Agent de migration
docs/SESSION_CONTEXT_PHASE3.md                 # CE FICHIER
```

---

## Commandes Utiles

### Lancer l'agent de migration
```
Utiliser le Task tool avec subagent_type="db-refactor-migration-agent"
```

### Validation apres chaque etape
```bash
# Tests de caracterisation
pytest tests/integration/ -v

# Tests unitaires
pytest tests/domain/ tests/infrastructure/ -v

# Tous les tests
pytest tests/ -v --ignore=tests/integration/

# Verifier que l'app demarre
streamlit run streamlit_ui.py
```

### Rollback si probleme
```bash
# Annuler changements non commites
git checkout -- [fichier]

# Revenir au commit precedent
git revert HEAD
```

---

## Checkpoints de Validation

| Checkpoint | Commande | Attendu |
|------------|----------|---------|
| Container OK | `python -c "from archon.container import get_repository"` | Pas d'erreur |
| agent_tools OK | `python -c "import archon.agent_tools"` | Pas d'erreur |
| Tests caracterisation | `pytest tests/integration/ -v` | 100% pass |
| Tests unitaires | `pytest tests/domain/ tests/infrastructure/ -v` | 100% pass |
| App demarre | `streamlit run streamlit_ui.py` | UI accessible |

---

## Risques Identifies

| Risque | Impact | Mitigation |
|--------|--------|------------|
| Regression fonctionnelle | ELEVE | Tests de caracterisation apres chaque migration |
| Signatures incompatibles | MOYEN | Mode dual avec fallback |
| Dependances circulaires | MOYEN | Import lazy dans container.py |
| Performance degradee | FAIBLE | Tests de performance en Phase 4 |

---

## Strategie de Migration

### Option A: Remplacement Direct
- Plus rapide
- Plus risque
- Pas de rollback facile

### Option B: Mode Dual (RECOMMANDE)
- Ajouter parametre `repository` optionnel
- Garder l'ancien code comme fallback
- Migration progressive
- Rollback facile

```python
# Exemple de mode dual
async def search_documentation(
    query: str,
    repository: Optional[ISitePagesRepository] = None  # Nouveau
) -> list[dict]:
    if repository is not None:
        # Nouveau code avec repository
        results = await repository.search_similar(...)
        return [convert(r) for r in results]

    # Fallback: ancien code (sera supprime en Phase 4)
    return supabase.rpc(...).execute().data
```

---

## Prochaine Action

**Lancer l'agent `db-refactor-migration-agent`** pour:

1. Creer `archon/container.py`
2. Valider que les imports fonctionnent
3. Commit
4. Passer a l'etape 2 (agent_tools.py)

---

## Notes Importantes

1. **Ne PAS continuer vers Phase 4** avant que TOUTES les etapes de Phase 3 soient validees
2. **Les tests de caracterisation** sont le filet de securite - ne jamais les ignorer
3. **Un commit = une etape** - facilite le rollback
4. **Mettre a jour Archon** apres chaque etape completee

---

*Contexte sauvegarde pour reprise de session*
