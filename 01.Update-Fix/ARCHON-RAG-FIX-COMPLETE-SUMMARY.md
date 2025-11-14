# Archon RAG Search Fix - Complete Summary

## Problem Overview

After restoring Archon database from backup, RAG search was completely broken with multiple cascading errors.

## Root Causes Discovered

### 1. **Permission Denied on archon_page_metadata**
**Error**: `permission denied for table archon_page_metadata`

**Root Cause**: Migration `011_add_page_metadata_table.sql` created the table but forgot:
- RLS (Row Level Security) policies
- TABLE-level GRANT statements

**Fix**: `ARCHON-FIX-PAGE-METADATA-PERMISSIONS.sql`
- Enabled RLS
- Created policies for public/authenticated/service_role
- Executed GRANT statements via Supabase SQL Editor

**Result**: ✅ 28 permissions set (4 roles × 7 privileges)

---

### 2. **Type Mismatch: VARCHAR vs TEXT**
**Error**:
```
structure of query does not match function result type
DETAIL: Returned type text does not match expected type character varying in column 2
```

**Root Cause**:
- Database restored WITHOUT 2025-09-30 type fixes
- Table columns use TEXT but functions returned VARCHAR
- Documented in `CLAUDE-ARCHON-UPDATE.md` but not applied

**Fix**: Changed all search function return types from VARCHAR → TEXT

---

### 3. **Wrong Embedding Dimension (Hardcoded 1536)**
**Error**: RAG search returned 0 results despite successful crawl

**Root Cause**:
```sql
CREATE OR REPLACE FUNCTION match_archon_crawled_pages (
  query_embedding VECTOR(1536),  -- HARDCODED!
  ...
) AS $$
BEGIN
  RETURN QUERY SELECT * FROM match_archon_crawled_pages_multi(
    query_embedding, 1536, ...  -- Always searches embedding_1536 column
  );
END;
$$;
```

But actual data was in `embedding_768` column (Google text-embedding-004 uses 768 dimensions).

**Fix**: Auto-detect dimension using `vector_dims()` function:
```sql
CREATE OR REPLACE FUNCTION match_archon_crawled_pages (
  query_embedding VECTOR,  -- No dimension constraint
  ...
) AS $$
DECLARE
  detected_dimension INT;
BEGIN
  detected_dimension := vector_dims(query_embedding);  -- AUTO-DETECT!

  RETURN QUERY SELECT * FROM match_archon_crawled_pages_multi(
    query_embedding,
    detected_dimension,  -- Dynamic!
    ...
  );
END;
$$;
```

---

### 4. **Type Mismatch: FLOAT vs DOUBLE PRECISION**
**Error**:
```
structure of query does not match function result type
DETAIL: Returned type real does not match expected type double precision in column 8
```

**Root Cause**:
- Functions returned FLOAT (which is REAL = 4 bytes)
- But PostgreSQL `ts_rank_cd()` returns DOUBLE PRECISION (8 bytes)
- Type mismatch in `rank_score` column (column 8)

**Fix**: Changed return types from FLOAT → DOUBLE PRECISION

---

### 5. **Missing match_type Column**
**Error**: `Hybrid document search failed: 'match_type'`

**Root Cause**:
- My initial SQL fixes removed the `match_type` column
- Python code expected `row["match_type"]`
- Original hybrid search uses FULL OUTER JOIN to track which method found each result

**Fix**: Restored proper hybrid search with match_type tracking:
```sql
RETURNS TABLE (
  ...
  similarity DOUBLE PRECISION,
  match_type TEXT  -- ADDED BACK!
)
...
WITH vector_results AS (...),
     text_results AS (...),
     combined_results AS (
       SELECT
         ...
         CASE
           WHEN v.id IS NOT NULL AND t.id IS NOT NULL THEN 'hybrid'
           WHEN v.id IS NOT NULL THEN 'vector'
           ELSE 'keyword'
         END AS match_type
       FROM vector_results v
       FULL OUTER JOIN text_results t ON v.id = t.id
     )
SELECT * FROM combined_results
```

---

### 6. **API Request Field Name (User Error)**
**Error**: Source filter not working in API requests

**Root Cause**: Used wrong field name in API request
```json
{
  "query": "...",
  "source_id": "...",  // WRONG!
  "match_count": 5
}
```

But API expects:
```python
class RagQueryRequest(BaseModel):
    query: str
    source: str | None = None  # CORRECT!
    match_count: int = 5
    return_mode: str = "chunks"
```

**Fix**: Use `source` instead of `source_id` in API requests

---

## Complete SQL Fix

**File**: `ARCHON-FIX-COMPLETE-WITH-MATCH-TYPE.sql`

This single SQL file fixes ALL database issues:
1. ✅ VARCHAR → TEXT for url and source_id
2. ✅ FLOAT → DOUBLE PRECISION for similarity and rank_score
3. ✅ Removed VECTOR(1536) constraint → generic VECTOR
4. ✅ Auto-detect dimension using vector_dims()
5. ✅ Restored match_type column with FULL OUTER JOIN logic

## Execution Steps

1. **Apply permission fix** (if needed):
   ```bash
   docker exec -i supabase-db psql -U postgres -d postgres < ARCHON-FIX-GRANTS-ONLY.sql
   ```

2. **Apply complete search function fix**:
   ```bash
   docker exec -i supabase-db psql -U postgres -d postgres < ARCHON-FIX-COMPLETE-WITH-MATCH-TYPE.sql
   ```

3. **Restart Supabase** to clear cached schemas:
   ```bash
   cd /Users/illa/Archon/supabase
   docker compose restart
   ```

4. **Restart Archon server** to clear Python cache:
   ```bash
   docker compose -f /Users/illa/Archon/docker-compose.yml restart archon-server
   ```

## Verification Tests

### Database Level Test
```sql
WITH test_emb AS (
    SELECT embedding_768 FROM archon_crawled_pages
    WHERE source_id = 'a0e86e00d806739a' AND embedding_768 IS NOT NULL
    LIMIT 1
)
SELECT
    id,
    LEFT(content, 50) as content_preview,
    similarity,
    match_type
FROM hybrid_search_archon_crawled_pages(
    (SELECT embedding_768 FROM test_emb),
    'Archon MCP server',
    5
);
```

**Expected**: 5 results with correct similarity scores and match_type

### API Level Test
```python
import requests

response = requests.post(
    'http://localhost:8181/api/knowledge-items/search',
    headers={
        'Content-Type': 'application/json',
        'Authorization': 'Bearer archon-claude-dev-key-2025'
    },
    json={
        'query': 'docker compose build services',
        'source': 'a0e86e00d806739a',  # Use 'source' not 'source_id'!
        'match_count': 5
    }
)

print(response.json())
```

**Expected**:
- `status_code`: 200
- `total_found`: 5
- `search_mode`: "hybrid"
- All results from `source_id`: 'a0e86e00d806739a'
- Valid `similarity_score` values (not 0.0)
- Valid `rerank_score` values

## Final Status

✅ **All Issues Resolved**

| Issue | Status |
|-------|--------|
| Permission denied | ✅ FIXED |
| Crawl successful | ✅ VERIFIED |
| VARCHAR/TEXT mismatch | ✅ FIXED |
| Dimension mismatch (1536 vs 768) | ✅ FIXED |
| FLOAT/DOUBLE PRECISION mismatch | ✅ FIXED |
| Missing match_type column | ✅ FIXED |
| Source filter working | ✅ VERIFIED |
| RAG search returns results | ✅ WORKING |

## Test Results

**Database crawled**: 1 page, 5 chunks
**Embeddings generated**: 5 × 768-dimensional vectors (Google text-embedding-004)
**Search results**: 5 relevant chunks found
**Similarity scores**: 0.60, 0.56, 0.54, 0.54, 0.52 (valid!)
**Match types**: "vector", "hybrid", "keyword" (working!)

## Key Learnings

1. **Always apply migration fixes**: Document restoration must include schema fixes
2. **Dimension flexibility**: Don't hardcode embedding dimensions - auto-detect
3. **Type consistency**: PostgreSQL is strict about REAL vs DOUBLE PRECISION
4. **API contracts**: Use correct field names (source vs source_id)
5. **Full testing**: Test at database level AND API level
6. **Cache awareness**: Restart services after schema changes

## Future Prevention

1. **Update migration 011**: Add missing GRANT statements and RLS policies
2. **Document required fixes**: Update restore procedure in CLAUDE-ARCHON-SUPABASE.md
3. **Add integration tests**: Test RAG search after database restore
4. **Version compatibility**: Track which migrations are required for each version

## Files Created

- `ARCHON-FIX-PAGE-METADATA-PERMISSIONS.sql` - Initial permission fix
- `ARCHON-FIX-GRANTS-ONLY.sql` - Simplified grants-only version
- `ARCHON-FIX-SEARCH-FUNCTIONS-COMPLETE.sql` - First attempt (missed match_type)
- `ARCHON-FIX-HYBRID-SEARCH-DOUBLE-PRECISION.sql` - DOUBLE PRECISION fix
- `ARCHON-FIX-COMPLETE-WITH-MATCH-TYPE.sql` - ✅ **COMPLETE SOLUTION**
- `ARCHON-RAG-FIX-COMPLETE-SUMMARY.md` - This document

## Date

2025-10-14

## Contributors

- Issue discovery and fixes: Claude (Sonnet 4.5)
- Database restoration context: User (illa)
- Testing and verification: Combined effort
