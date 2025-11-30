# Plan: Gestion des Environnements Virtuels et Dépendances

**Date**: 2025-11-30
**Status**: IMPLÉMENTÉ
**Objectif**: Éliminer les problèmes de dépendances et avoir des environnements reproductibles

---

## Problème Identifié

Aujourd'hui, on a rencontré un conflit majeur :
- Le code (`archon_graph.py`) utilise `pydantic_ai.providers.openai` (API v1.x)
- Le `requirements.txt` spécifiait `pydantic-ai==0.0.22` (API v0.x)
- Cascade de conflits : `anthropic`, `cohere`, `huggingface-hub`...

**Cause racine** : Pas de gestion d'environnement virtuel, dépendances figées obsolètes.

---

## Solution Proposée

### 1. Structure des Fichiers de Dépendances

```
archon/
├── requirements.txt           # Production - versions exactes (pip freeze)
├── requirements-staging.txt   # Staging PostgreSQL - versions flexibles
├── requirements-dev.txt       # Développement local - versions flexibles + outils dev
├── requirements-base.txt      # Dépendances core communes (importé par les autres)
└── pyproject.toml             # (Optionnel futur) Pour packaging moderne
```

### 2. Contenu de Chaque Fichier

#### `requirements-base.txt` (Dépendances Core)
```txt
# Core AI/LLM
pydantic-ai>=1.0.15
langgraph>=0.2.0
openai>=1.50.0
anthropic>=0.69.0

# Web Framework
streamlit>=1.40.0
fastapi>=0.115.0
uvicorn>=0.34.0

# Database (abstrait - les implémentations sont dans les fichiers spécifiques)
# Aucune dépendance DB ici

# Utilities
python-dotenv>=1.0.0
pyyaml>=6.0.0
tenacity>=9.0.0
httpx>=0.27.0
```

#### `requirements-dev.txt` (Développement Local)
```txt
-r requirements-base.txt

# Database - Supabase pour dev
supabase>=2.0.0

# PostgreSQL optionnel
asyncpg>=0.29.0
pgvector>=0.2.0

# Outils de développement
pytest>=8.0.0
pytest-asyncio>=0.23.0
pytest-cov>=4.0.0
black>=24.0.0
ruff>=0.1.0
mypy>=1.0.0

# Debug
ipython>=8.0.0
rich>=13.0.0
```

#### `requirements-staging.txt` (Staging PostgreSQL)
```txt
-r requirements-base.txt

# Database - PostgreSQL natif
asyncpg>=0.29.0
pgvector>=0.2.0

# Pas de Supabase - on teste le backend PostgreSQL pur

# Crawling (nécessaire pour le staging)
Crawl4AI>=0.4.0
beautifulsoup4>=4.12.0
playwright>=1.49.0

# Testing dans le container
pytest>=8.0.0
```

### 3. Environnements Virtuels

#### Structure Recommandée
```
archon/
├── venv/                 # Développement local (gitignored)
├── venv-staging/         # Tests staging local (gitignored, optionnel)
└── .venv/                # Alternative pour certains IDE (gitignored)
```

#### Scripts de Setup

**`scripts/setup-dev.sh`** (Linux/Mac)
```bash
#!/bin/bash
python -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements-dev.txt
echo "✅ Environnement dev prêt. Activez avec: source venv/bin/activate"
```

**`scripts/setup-dev.ps1`** (Windows PowerShell)
```powershell
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install --upgrade pip
pip install -r requirements-dev.txt
Write-Host "✅ Environnement dev prêt. Activez avec: .\venv\Scripts\Activate.ps1"
```

### 4. Docker : Séparation Claire

| Container | Requirements | Usage |
|-----------|--------------|-------|
| `archon:latest` | `requirements.txt` | Production Supabase |
| `archon-staging:latest` | `requirements-staging.txt` | Staging PostgreSQL |
| `archon-mcp:latest` | `requirements.txt` | MCP Server |

### 5. Workflow de Mise à Jour des Dépendances

```
1. Modifier requirements-base.txt (ou -dev/-staging)
   ↓
2. Recréer le venv local
   pip install -r requirements-dev.txt
   ↓
3. Tester localement
   ↓
4. Si OK, regénérer requirements.txt (prod)
   pip freeze > requirements.txt
   ↓
5. Rebuild Docker si nécessaire
```

---

## Plan d'Implémentation

### Phase 1: Créer les Fichiers (30 min) - COMPLÉTÉ
- [x] Créer `requirements-base.txt`
- [x] Créer `requirements-dev.txt`
- [x] Mettre à jour `requirements-staging.txt`
- [x] Créer scripts setup (`setup-dev.sh`, `setup-dev.ps1`, `setup-staging.sh`, `setup-staging.ps1`)

### Phase 2: Mettre à Jour requirements.txt (15 min) - EN ATTENTE
- [ ] Regénérer `requirements.txt` depuis un venv propre avec les bonnes versions
- [ ] Valider que le build Docker production fonctionne

### Phase 3: Documenter (15 min) - EN ATTENTE
- [ ] Mettre à jour README avec instructions venv
- [ ] Ajouter section "Développement Local"

### Phase 4: Valider (30 min) - PARTIELLEMENT COMPLÉTÉ
- [ ] Tester création venv depuis zéro
- [ ] Tester build Docker production
- [x] Tester build Docker staging (SUCCESS - pydantic-ai 1.25.1)

---

## Bénéfices Attendus

1. **Reproductibilité** : Chaque développeur a le même environnement
2. **Isolation** : Les dépendances du projet n'affectent pas le système
3. **Clarté** : On sait exactement quelles dépendances sont utilisées où
4. **Debugging facile** : Si erreur, on sait que c'est dans le code, pas les deps
5. **CI/CD ready** : Facile à intégrer dans GitHub Actions

---

## Questions pour Validation

1. **Veux-tu qu'on implémente ça maintenant ?**
2. **Préfères-tu garder un seul `requirements.txt` ou la structure séparée ?**
3. **As-tu besoin d'un venv local ou tu travailles uniquement via Docker ?**

---

## Notes Techniques

- Python 3.10+ requis (on utilise des features modernes)
- Le `.gitignore` doit inclure `venv/`, `.venv/`, `venv-*/`
- Pour Windows, utiliser PowerShell (pas cmd) pour l'activation du venv
