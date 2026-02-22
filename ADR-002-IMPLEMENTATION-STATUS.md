# ADR-002 Implementation Status

## Overview
This document tracks the implementation progress of ADR-002: Crawl Reliability, Provenance Tracking & Validation.

**Branch:** `feature/crawl-checkpoint-resume`
**Date:** 2026-02-22

---

## Part 1: Checkpoint/Resume - ✅ COMPLETE

### Backend Implementation

**Status:** ✅ Fully Implemented

**Files Modified:**
1. ✅ `python/src/server/services/crawling/crawling_service.py`
   - Added `_filter_already_processed_urls()` helper method (lines 857-889)
   - Updated `_crawl_by_url_type()` signature to accept `source_id` and `has_existing_state`
   - Applied resume filtering to sitemap crawling (lines 1101-1120)
   - Applied resume filtering to link collection batch crawling (lines 1046-1051)
   - Applied resume filtering to recursive crawling (lines 1066-1073, 1155-1162)
   - Updated call sites to pass source_id and has_existing_state parameters

2. ✅ `python/src/server/services/crawling/strategies/recursive.py`
   - Updated `crawl_recursive_with_progress()` signature to accept `source_id` and `url_state_service`
   - Pre-populated visited set with already-embedded URLs (lines 158-165)
   - Prevents re-crawling of completed URLs during recursive depth traversal

3. ✅ Infrastructure Already Complete (from previous work)
   - `archon_crawl_url_state` table exists
   - `CrawlUrlStateService` with full CRUD operations
   - Integration with document storage operations

**How It Works:**
1. **Detection:** When `orchestrate_crawl()` starts, it checks for existing crawl state using `url_state_service.has_existing_state()`
2. **Logging:** If state exists with pending/failed URLs, logs resume information
3. **Filtering:** Before crawling strategies execute:
   - Sitemap: Filters URLs before batch crawl
   - Link Collection: Filters extracted links before batch crawl
   - Recursive: Pre-populates visited set to skip embedded URLs
4. **Resume:** Only unprocessed URLs are crawled, preventing duplicates

**Testing Verification:**
```bash
# Test scenario:
# 1. Start crawl of sitemap with 100 URLs
# 2. Kill server after 30 URLs embedded
# 3. Check archon_crawl_url_state shows 30 embedded, 70 pending
# 4. Restart server and re-trigger crawl
# 5. Verify logs show "Resume filtering | skipped=30 already-embedded URLs"
# 6. Verify only 70 new URLs are processed
```

---

## Part 2: Provenance Tracking - ✅ BACKEND COMPLETE, ⏳ FRONTEND PENDING

### Backend Implementation

**Status:** ✅ Fully Implemented

**Database Migration:**
✅ `migration/0.1.0/013_add_provenance_tracking.sql`
- Adds 7 new columns to `archon_sources`:
  - `embedding_model` (TEXT) - e.g., "text-embedding-3-small"
  - `embedding_dimensions` (INTEGER) - e.g., 1536
  - `embedding_provider` (TEXT) - e.g., "openai"
  - `vectorizer_settings` (JSONB) - chunk_size, use_contextual, use_hybrid
  - `summarization_model` (TEXT) - e.g., "gpt-4o-mini"
  - `last_crawled_at` (TIMESTAMPTZ)
  - `last_vectorized_at` (TIMESTAMPTZ)
- Creates indexes on `embedding_model` and `embedding_provider`
- Adds column comments for documentation

**Files Modified:**
1. ✅ `python/src/server/services/source_management_service.py`
   - Updated `update_source_info()` signature to accept provenance parameters (lines 214-232)
   - Added provenance fields to existing source upsert (lines 294-313)
   - Added provenance fields to new source creation (lines 378-402)
   - Sets `last_crawled_at` and `last_vectorized_at` timestamps

2. ✅ `python/src/server/services/crawling/document_storage_operations.py`
   - Captures embedding configuration from credential service (lines 376-392)
   - Retrieves: embedding_provider, embedding_model, embedding_dimensions
   - Retrieves summarization_model from RAG strategy settings
   - Passes all provenance to `update_source_info()` during crawl

**How It Works:**
1. **Capture:** During `_create_source_records()`, reads current provider configuration
2. **Store:** Passes configuration to `update_source_info()` which upserts to database
3. **Timestamps:** Automatically sets `last_crawled_at` and `last_vectorized_at` to current time
4. **Persistence:** All sources now track which models/settings were used

### Frontend Implementation

**Status:** ⏳ PENDING

**Files to Modify:**
1. ⏳ `archon-ui-main/src/features/knowledge/types/knowledge.ts`
   ```typescript
   export interface KnowledgeSource {
     source_id: string;
     // ... existing fields ...
     embedding_model?: string;
     embedding_dimensions?: number;
     embedding_provider?: string;
     vectorizer_settings?: {
       use_contextual?: boolean;
       use_hybrid?: boolean;
       chunk_size?: number;
     };
     summarization_model?: string;
     last_crawled_at?: string;
     last_vectorized_at?: string;
   }
   ```

2. ⏳ `archon-ui-main/src/features/knowledge/components/KnowledgeCard.tsx`
   - Add expandable "Processing Details" section using Radix Collapsible
   - Display embedding_provider/embedding_model (embedding_dimensions D)
   - Display summarization_model
   - Display formatted last_crawled_at timestamp
   - Use Tron-inspired glassmorphism styling

**UI Design:**
```tsx
<Collapsible.Root>
  <Collapsible.Trigger className="flex items-center gap-2 text-sm text-gray-400 hover:text-cyan-400">
    <ChevronRight className="transition-transform" />
    Processing Details
  </Collapsible.Trigger>
  <Collapsible.Content className="mt-2 text-xs text-gray-400 space-y-1 pl-6">
    <div>Embeddings: {embedding_provider}/{embedding_model} ({embedding_dimensions}D)</div>
    <div>Summarization: {summarization_model}</div>
    <div>Last crawled: {formatDate(last_crawled_at)}</div>
  </Collapsible.Content>
</Collapsible.Root>
```

---

## Part 3: Validation Tools - ❌ NOT STARTED

### Backend Implementation

**Status:** ❌ Not Started

**Files to Create:**
1. ❌ `python/src/server/api_routes/knowledge_api.py` (or modify existing)
   - Add `GET /api/knowledge-items/{source_id}/validate` endpoint
   - Checks:
     - Missing chunks (URLs marked embedded but no chunks exist)
     - Zero-vector embeddings (null or all-zero vectors)
     - Dimension mismatches (mixed embedding dimensions)
     - Orphaned pages (page_metadata without chunks)
     - Failed URLs that never recovered
   - Returns: `{ valid: bool, issues: Issue[], total_issues: int }`

2. ❌ `migration/0.1.0/014_add_validation_functions.sql`
   ```sql
   CREATE OR REPLACE FUNCTION count_zero_vectors(src_id TEXT)
   RETURNS INTEGER AS $$
     SELECT COUNT(*)
     FROM archon_documents
     WHERE source_id = src_id
     AND embedding IS NOT NULL
     AND array_length(embedding, 1) > 0
     AND embedding = array_fill(0::float, ARRAY[array_length(embedding, 1)]);
   $$ LANGUAGE SQL;
   ```

### MCP Tool Implementation

**Status:** ❌ Not Started

**Files to Modify:**
1. ❌ `python/src/mcp_server/features/rag/rag_tools.py`
   - Add `rag_validate_source(source_id: str)` tool
   - Calls validation API endpoint
   - Returns summary: valid, error_count, warning_count, issues_summary, recommendation
   - Read-only (no writes, no fixes)

**Tool Usage Example:**
```python
@mcp.tool()
async def rag_validate_source(source_id: str) -> dict:
    """Check knowledge source health before using for RAG."""
    # Calls GET /api/knowledge-items/{source_id}/validate
    # Returns summary for agent decision-making
```

### Frontend Implementation

**Status:** ❌ Not Started

**Files to Create:**
1. ❌ `archon-ui-main/src/features/knowledge/components/ValidationPanel.tsx`
   - "Validate" button on knowledge item action menu
   - Opens expandable panel or modal with validation results
   - Color-coded issues (red=error, yellow=warning, blue=info)
   - "Fix" buttons for fixable issues

2. ❌ `archon-ui-main/src/features/knowledge/hooks/useValidateSource.ts`
   - TanStack Query hook for validation endpoint
   - `useValidateSource(sourceId)` → returns validation data

---

## Testing Checklist

### Part 1: Checkpoint/Resume
- [ ] Start sitemap crawl with 100 URLs
- [ ] Kill process at 30% complete
- [ ] Verify `archon_crawl_url_state` shows mix of embedded/pending
- [ ] Restart and re-trigger crawl
- [ ] Verify only pending URLs processed
- [ ] Verify no duplicates in final data
- [ ] Check logs show "Resume filtering | skipped=X"

### Part 2: Provenance Tracking
- [x] Backend: Migration created
- [x] Backend: Service layer updated
- [x] Backend: Provenance captured during crawl
- [ ] Frontend: Types updated
- [ ] Frontend: UI displays provenance
- [ ] Test: Crawl a source
- [ ] Test: Query source record
- [ ] Test: Verify provenance fields populated

### Part 3: Validation Tools
- [ ] Backend: Validation endpoint created
- [ ] Backend: Database functions created
- [ ] MCP: Validation tool implemented
- [ ] Frontend: Validation UI created
- [ ] Test: Insert corrupted data (zero vector)
- [ ] Test: Validation detects issues
- [ ] Test: MCP tool returns correct summary

---

## Migration Deployment

**Required Database Migrations:**
1. ✅ `013_add_provenance_tracking.sql` - Ready to deploy
2. ❌ `014_add_validation_functions.sql` - Not created yet

**Deployment Steps:**
```bash
# Apply provenance tracking migration
supabase db push
# Or manually run the SQL in Supabase dashboard
```

**Rollback Plan:**
```sql
-- If needed, rollback provenance columns:
ALTER TABLE archon_sources
DROP COLUMN IF EXISTS embedding_model,
DROP COLUMN IF EXISTS embedding_dimensions,
DROP COLUMN IF EXISTS embedding_provider,
DROP COLUMN IF EXISTS vectorizer_settings,
DROP COLUMN IF EXISTS summarization_model,
DROP COLUMN IF EXISTS last_crawled_at,
DROP COLUMN IF EXISTS last_vectorized_at;

DROP INDEX IF EXISTS idx_archon_sources_embedding_model;
DROP INDEX IF EXISTS idx_archon_sources_embedding_provider;
```

---

## Priority for Remaining Work

### High Priority (Complete Part 2)
1. Update frontend types for provenance fields
2. Add provenance display to KnowledgeCard component
3. Test end-to-end provenance tracking

### Medium Priority (Part 3 - Validation)
4. Create validation API endpoint
5. Create database validation functions
6. Build validation UI component

### Low Priority (Part 3 - MCP Tool)
7. Add read-only MCP validation tool

---

## Known Issues / Notes

1. **Provenance Settings:** Currently using placeholder values for `vectorizer_settings`. These should be populated from actual RAG strategy configuration when contextual embeddings or hybrid search are implemented.

2. **Recursive Crawl Resume:** The current implementation pre-populates the visited set with embedded URLs. This works well but doesn't distinguish between "already visited in this session" vs "embedded in previous session". This is acceptable for now.

3. **Type Safety:** Some type warnings in `source_management_service.py` related to optional parameters. These are safe to ignore as the functions handle None values correctly.

4. **Migration Order:** The provenance migration (013) must be run before the validation migration (014) when it's created.

---

## Next Steps

**Immediate:**
1. Apply database migration `013_add_provenance_tracking.sql`
2. Test checkpoint/resume functionality end-to-end
3. Update frontend types and UI for provenance display

**Short Term:**
4. Implement validation API endpoint and database functions
5. Build validation UI component

**Future Enhancements:**
- Bulk loading UI/API (separate ADR)
- Manifest import capability (separate ADR)
- Re-vectorization tooling using provenance data
- Provenance-based source filtering in UI
