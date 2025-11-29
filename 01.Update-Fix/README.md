# Archon Update-Fix Ordner

Dieser Ordner enthält alle kritischen Fixes für PostgreSQL Search Functions und Security.

## 📋 Verwendung

### Nach jedem `git pull` oder Update:

```bash
# 1. Search Function Fixes anwenden
docker exec -i supabase-db psql -U postgres -d postgres < 01.Update-Fix/ARCHON-FIX-COMPLETE-WITH-MATCH-TYPE.sql

# 2. Security Fixes anwenden (RLS Policies & Triggers)
docker exec -i supabase-db psql -U postgres -d postgres < 01.Update-Fix/ARCHON-FIX-SECURITY-RLS-POLICIES.sql

# 3. Server neu starten
docker compose restart archon-server

# 4. Verifizieren
python3 01.Update-Fix/test_rag_search.py
```

## 📁 Dateien

### Haupt-Fixes (Beide anwenden!)
- **ARCHON-FIX-COMPLETE-WITH-MATCH-TYPE.sql** ⭐
  - Fixes für Search Functions (Type Mismatches, Dimensions)
  - Führe diese Datei nach jedem Update aus!

- **ARCHON-FIX-SECURITY-RLS-POLICIES.sql** 🔒
  - Security Fixes (RLS Policies, GRANT Statements)
  - Trigger für updated_at Timestamps
  - Führe diese Datei nach jedem Update aus!

### Dokumentation
- **ARCHON-RAG-FIX-COMPLETE-SUMMARY.md**
  - Vollständige Zusammenfassung aller Fixes
  - Schritt-für-Schritt Anleitung

- **ARCHON-BUG-ANALYSIS.md**
  - Detaillierte Root-Cause-Analyse
  - Wer hat was versaut?
  - Update-Resistenz Bewertung

### Historische Fixes (Archiv)
- ARCHON-FIX-GRANTS-ONLY.sql
- ARCHON-FIX-HYBRID-SEARCH-DOUBLE-PRECISION.sql
- ARCHON-FIX-PAGE-METADATA-PERMISSIONS.sql
- ARCHON-FIX-SEARCH-FUNCTIONS-COMPLETE.sql

## 🐛 Welche Bugs werden gefixt?

### 1. VARCHAR → TEXT Mismatch
```
ERROR: structure of query does not match function result type
DETAIL: Returned type text does not match expected type character varying
```

### 2. FLOAT → DOUBLE PRECISION Mismatch
```
ERROR: Returned type real does not match expected type double precision in column 8
```

### 3. Hardcoded vector(1536) Dimension
```
PROBLEM: RAG search returns 0 results with Google text-embedding-004 (768-dim)
```

### 4. Missing Permissions
```
ERROR: permission denied for table archon_page_metadata
```

## ✅ Verification

Nach dem Fix sollte dieser Test funktionieren:

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
        'source': 'your-source-id',  # 'source' nicht 'source_id'!
        'match_count': 5
    }
)

print(f"Status: {response.status_code}")
print(f"Success: {response.json()['success']}")
print(f"Results: {len(response.json()['results'])}")
```

Erwartete Ausgabe:
```
Status: 200
Success: True
Results: 5
```

## 🔄 PR Status

**Branch**: `fix/postgresql-search-functions-type-mismatches`

**Commit**: Lokale Änderungen committed

**Status**: Bereit zum Pushen

### PR manuell erstellen:

```bash
# 1. Branch pushen
git push -u origin fix/postgresql-search-functions-type-mismatches

# 2. PR auf GitHub erstellen:
# https://github.com/coleam00/Archon/compare/fix/postgresql-search-functions-type-mismatches
```

## 📊 Impact

**Betroffene Funktionen**: 8 PostgreSQL Search Functions
**Betroffene Dateien**: 3 Migration Files
**Update-Resistenz**: ⚠️ **LOW** - Muss nach jedem Git Pull neu angewendet werden

## 💡 Tipp

Erstelle einen Git Hook um den Fix automatisch anzuwenden:

```bash
# .git/hooks/post-merge
#!/bin/bash
echo "Applying PostgreSQL search function fixes..."
docker exec -i supabase-db psql -U postgres -d postgres < 01.Update-Fix/ARCHON-FIX-COMPLETE-WITH-MATCH-TYPE.sql
docker compose restart archon-server
echo "✅ Fixes applied!"
```

Dann: `chmod +x .git/hooks/post-merge`

---

**Erstellt**: 2025-10-14
**Letztes Update**: 2025-10-14
**Version**: 1.0
