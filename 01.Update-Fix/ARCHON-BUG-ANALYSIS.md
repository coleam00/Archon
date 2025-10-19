# Archon RAG Bug Analysis - Root Cause Report

## TL;DR - Was ist passiert?

**KOMBINATION aus User Error + Original Git Bugs**

1. ✅ User hatte VARCHAR→TEXT Fix am 2025-09-30 bereits gemacht und dokumentiert
2. ❌ Beim Database Restore gestern wurden diese Fixes NICHT angewendet ("minimal updates - nur .env")
3. ❌ Mehrere Bugs existieren im Original Git Repo und wurden nie gefixt

---

## Detaillierte Analyse

### Issue 1: VARCHAR → TEXT (Dokumentiert, aber nicht angewendet)

**Status in CLAUDE-ARCHON-UPDATE.md (Section 5)**:
```
PostgreSQL Hybrid Search Functions Type Fix (2025-09-30)
- Changed all "url VARCHAR" to "url TEXT" in RETURNS TABLE
- Update-Resistant: ⚠️ MEDIUM - Migration files can be overwritten
- Action Required: When updating, check migration files and replace VARCHAR with TEXT
```

**Was passiert ist**:
- User hatte diesen Fix am 30.09.2025 gemacht ✅
- Beim DB Restore gestern: "minimal updates - nur .env" ❌
- Fix wurde NICHT angewendet ❌

**Schuld**: 🔴 **USER ERROR** - Dokumentierter Fix nicht angewendet

**Original Git Status** (HEAD: commit 3f0815b):
```bash
$ git show HEAD:migration/complete_setup.sql | grep "url VARCHAR"
url VARCHAR  # ❌ BUG existiert im Original Git!
```

**Schuld**: 🔴 **AUCH GIT BUG** - VARCHAR existiert im Original Repo

---

### Issue 2: Hardcoded vector(1536) Dimension

**Original Git (commit 85bd6bc - September 2025)**:
```sql
CREATE OR REPLACE FUNCTION hybrid_search_archon_crawled_pages(
    query_embedding vector(1536),  -- ❌ HARDCODED!
    ...
)
```

**Problem**:
- Wrapper function ruft `_multi` mit hardcoded dimension=1536
- Aber User nutzt Google text-embedding-004 = 768 dimensions
- → Sucht in `embedding_1536` Spalte (NULL) statt `embedding_768` (DATA)

**Dokumentiert?**: ❌ NEIN - nicht in CLAUDE-ARCHON-UPDATE.md
**Fix existiert im Git?**: ❌ NEIN - Bug existiert bis HEAD

**Schuld**: 🔴 **ORIGINAL GIT BUG** - Nie gefixt

---

### Issue 3: FLOAT vs DOUBLE PRECISION

**Original Git (HEAD)**:
```sql
RETURNS TABLE (
    ...
    similarity FLOAT,  -- ❌ FLOAT = REAL (4 bytes)
    match_type TEXT
)
```

**Problem**:
- PostgreSQL `ts_rank_cd()` returns DOUBLE PRECISION (8 bytes)
- Function declares FLOAT (= REAL = 4 bytes)
- → Type mismatch error in column 8

**Dokumentiert?**: ❌ NEIN
**Fix existiert im Git?**: ❌ NEIN - Bug existiert bis HEAD

**Schuld**: 🔴 **ORIGINAL GIT BUG** - Nie gefixt

---

### Issue 4: match_type Column

**Status**: ✅ Korrekt im Original Git
```sql
RETURNS TABLE (
    ...
    match_type TEXT  -- ✅ Existiert
)
```

**Was passiert ist**:
- Mein erster Fix (ARCHON-FIX-SEARCH-FUNCTIONS-COMPLETE.sql) hatte match_type ENTFERNT
- Ich hatte die FULL OUTER JOIN Logik vereinfacht
- Python Code erwartet aber `row["match_type"]`

**Schuld**: 🔴 **MEIN FEHLER** - Incomplete fix

---

### Issue 5: Permission Denied (archon_page_metadata)

**Original Migration** (011_add_page_metadata_table.sql):
```sql
CREATE TABLE archon_page_metadata (...);
-- ❌ KEINE GRANT statements
-- ❌ KEINE RLS policies
```

**Dokumentiert?**: ❌ NEIN
**Fix existiert im Git?**: ❌ NEIN - Bug existiert im Original

**Schuld**: 🔴 **ORIGINAL GIT BUG** - Migration incomplete

---

## Zusammenfassung: Wer hat was versaut?

| Issue | User Error | Git Bug | Mein Fehler |
|-------|-----------|---------|-------------|
| **VARCHAR→TEXT** | ✅ Ja (nicht angewendet) | ✅ Ja (im Git) | ❌ Nein |
| **Hardcoded 1536** | ❌ Nein | ✅ Ja | ❌ Nein |
| **FLOAT→DOUBLE** | ❌ Nein | ✅ Ja | ❌ Nein |
| **match_type removed** | ❌ Nein | ❌ Nein | ✅ Ja |
| **Permission denied** | ❌ Nein | ✅ Ja | ❌ Nein |

---

## Update-Resistenz unserer Fixes

### ❌ NICHT Update-Resistent (werden überschrieben):

Alle SQL-Fixes in `/Users/illa/Archon/migration/` werden beim Git Pull überschrieben!

**Betroffene Files**:
- `migration/complete_setup.sql` ← überschrieben
- `migration/0.1.0/002_add_hybrid_search_tsvector.sql` ← überschrieben

### ✅ Fixes müssen ins Git Repo:

**Option 1: Pull Request ans Original Repo**
```
Fix: Complete PostgreSQL search function bugs

1. VARCHAR → TEXT (url, source_id columns)
2. vector(1536) → VECTOR with auto-detection
3. FLOAT → DOUBLE PRECISION (similarity, rank_score)
4. Add missing GRANT statements to migration 011
```

**Option 2: Fork & lokale Anpassungen**
- Eigenen Fork maintainen
- Nach jedem Upstream Pull: Fixes re-applyen

**Option 3: Post-Migration Script**
```bash
# Nach jedem Git Pull:
docker exec -i supabase-db psql -U postgres -d postgres < ARCHON-FIX-COMPLETE-WITH-MATCH-TYPE.sql
```

---

## Korrekte Update-Prozedur (für Zukunft)

### Schritt 1: Backup
```bash
cd /Users/illa/Archon/supabase
docker exec supabase-db pg_dump -U postgres postgres > backup.sql
```

### Schritt 2: Git Pull
```bash
cd /Users/illa/Archon
git pull
```

### Schritt 3: Fixes anwenden
```bash
# 1. Permission Fix (falls neue Tabellen)
docker exec -i supabase-db psql -U postgres -d postgres < ARCHON-FIX-GRANTS-ONLY.sql

# 2. Search Function Fix (IMMER!)
docker exec -i supabase-db psql -U postgres -d postgres < ARCHON-FIX-COMPLETE-WITH-MATCH-TYPE.sql
```

### Schritt 4: Services neu starten
```bash
cd /Users/illa/Archon
docker compose restart
```

### Schritt 5: Test
```python
import requests

response = requests.post(
    'http://localhost:8181/api/knowledge-items/search',
    headers={
        'Content-Type': 'application/json',
        'Authorization': 'Bearer archon-claude-dev-key-2025'
    },
    json={
        'query': 'test query',
        'match_count': 5
    }
)

assert response.status_code == 200
assert response.json()['success'] == True
print("✅ RAG search works!")
```

---

## Empfehlung für Zukunft

### 1. Fix ins Original Git Repo submitten

**PR Title**: `fix: Complete PostgreSQL search function type mismatches and auto-detect embedding dimensions`

**Changes**:
- `migration/complete_setup.sql`
- `migration/0.1.0/002_add_hybrid_search_tsvector.sql`
- `migration/0.1.0/011_add_page_metadata_table.sql`

### 2. CLAUDE-ARCHON-UPDATE.md ergänzen

Neue Section hinzufügen:
```markdown
### **X. PostgreSQL Function Fixes (2025-10-14)**

#### Auto-Detect Embedding Dimensions
- Fixed: Hardcoded vector(1536) in wrapper functions
- Now: Auto-detect using vector_dims() - supports 384/768/1024/1536/3072

#### Type Precision Fixes
- Fixed: FLOAT → DOUBLE PRECISION for similarity/rank_score
- Reason: ts_rank_cd() returns DOUBLE PRECISION

#### Complete Fix Script
Location: /Users/illa/Archon/ARCHON-FIX-COMPLETE-WITH-MATCH-TYPE.sql
Apply after: Every git pull or database restore
```

### 3. Automated Test hinzufügen

```python
# tests/integration/test_rag_search.py
def test_rag_search_with_multi_dimensional_embeddings():
    """Test RAG search works with 768-dim embeddings (Google)"""
    response = search("test", source="test-source")
    assert response.status_code == 200
    assert len(response.json()['results']) > 0
```

---

## Fazit

**Was haben WIR versaut?**
- ❌ User: VARCHAR→TEXT Fix nicht angewendet beim Restore
- ❌ Ich: match_type column in erstem Fix entfernt

**Was war schon im Git kaputt?**
- ❌ VARCHAR statt TEXT (nie ins Git gefixt)
- ❌ Hardcoded vector(1536) dimension
- ❌ FLOAT statt DOUBLE PRECISION
- ❌ Migration 011 ohne GRANT statements

**Lösung für Zukunft**:
1. ✅ PR ans Original Repo mit allen Fixes
2. ✅ Post-migration script für lokale Updates
3. ✅ Integration tests für RAG search

**Update-Resistenz**: ⚠️ **LOW** - Fixes müssen nach jedem Git Pull neu angewendet werden
