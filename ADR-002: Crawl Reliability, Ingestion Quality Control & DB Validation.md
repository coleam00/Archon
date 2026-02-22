# ADR-002: Crawl Reliability, Provenance Tracking & Validation

**Status:** In Progress  
**Date:** 2026-02-22  
**Authors:** [Zebastjan Johanzen, Perplexity]  
**Supersedes:** ADR-001 (fully merged)

---

## Context

With crawl targeting improvements (domain filtering, llms.txt/sitemap 
discovery) now resolved in main, the next foundational layer is ensuring 
that what gets stored is reliable, verifiable, and recoverable. Early 
end-to-end testing has confirmed three critical gaps:

1. **No crawl resilience** — mid-crawl failures produce duplicate or 
   missing data with no recovery path
2. **No provenance tracking** — impossible to know which embedding model, 
   vectorizer flags, or summarization settings were used on any stored source
3. **No validation tooling** — silent failures (null vectors, dimension 
   mismatches, stale embeddings) are invisible until RAG returns garbage

These gaps must be closed before Git integration, both because they are 
simpler in scope and because the AI coding assistant needs a trustworthy 
knowledge base to assist with the more complex Git integration work.

---

## Decision

Implement three tightly related capabilities as a single coherent effort, 
sharing a unified schema where checkpointing and validation data overlap.

---

## Phase 1: Crawl Checkpoint & Resume

**Problem:** Mid-crawl crashes currently leave the database in an unknown 
state — partially written chunks, duplicates, or nothing at all. There is 
no way to resume; the user must manually clean up and restart from scratch.

**Root causes confirmed:**
- Chunk writes are not idempotent (insert rather than upsert)
- No per-URL state tracking exists
- Docker memory detection reads host memory instead of container memory, 
  triggering false abort on memory pressure

**Implementation:**

Add a `crawl_url_state` table to track granular progress:

```sql
CREATE TABLE crawl_url_state (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id       UUID NOT NULL REFERENCES knowledge_sources(id),
    url             TEXT NOT NULL,
    status          TEXT NOT NULL,  -- pending | fetched | embedded | failed
    chunk_count     INTEGER,
    content_hash    TEXT,           -- for duplicate detection
    error_message   TEXT,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now(),
    UNIQUE(source_id, url)
);
```

**Status:** ✅ Complete (see ADR-002-IMPLEMENTATION-STATUS.md)

---

## Phase 2: Provenance Tracking

**Problem:** No way to know which embedding model, provider, dimensions, or 
summarization settings were used for any stored source.

**Implementation:**
- Add provenance columns to `archon_sources`:
  - `embedding_model` (TEXT)
  - `embedding_dimensions` (INTEGER)
  - `embedding_provider` (TEXT)
  - `vectorizer_settings` (JSONB)
  - `summarization_model` (TEXT)
  - `last_crawled_at` (TIMESTAMPTZ)
  - `last_vectorized_at` (TIMESTAMPTZ)

**Status:** ✅ Backend Complete, ⏳ Frontend Pending (see ADR-002-IMPLEMENTATION-STATUS.md)

---

## Phase 3: Validation Tools

**Problem:** Silent failures (null vectors, dimension mismatches, orphaned pages) 
are invisible until RAG returns garbage.

**Implementation:**
- Add validation API endpoint
- Add database validation functions
- Add MCP validation tool
- Add frontend validation UI

**Status:** ❌ Not Started (see ADR-002-IMPLEMENTATION-STATUS.md)

---

## Future: Git Integration

With a resumable, reprocessable pipeline with provenance and validation in 
place, Git integration becomes the next major feature (separate ADR).
