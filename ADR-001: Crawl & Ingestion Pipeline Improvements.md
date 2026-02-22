# ADR-001: Crawl & Ingestion Pipeline Improvements

**Status:** In Progress  
**Date:** 2026-02-22  
**Authors:** Zebastjan Johanzen

---

## Context

Archon's crawler and ingestion pipeline is the foundation everything else 
depends on — MCP agent quality, RAG search accuracy, and AI coding assistant 
usefulness all trace back to whether the knowledge base contains clean, 
well-processed, verifiable data.

This ADR tracks remaining improvements needed for the crawl & ingestion pipeline.

---

## Completed ✅

The following have already been implemented:

| Feature | Status | Notes |
|---------|--------|-------|
| `CrawlStatus.discovery` enum | ✅ Done | Progress model includes discovery stage |
| Domain filtering | ✅ Done | Both UI controls and backend filtering |
| Priority discovery (llms.txt → sitemap → full) | ✅ Done | DiscoveryService with correct priority order |
| Per-chunk embedding metadata | ✅ Done | `embedding_model`, `embedding_dimension` on `archon_crawled_pages` |
| Chunk deduplication | ✅ Done | Unique constraint on `(url, chunk_number)` |

---

## Remaining Work

### Phase 1: Crawl Checkpoint & Resume

**Scope:** Add crawl state tracking so interrupted crawls can resume.

**Problems solved:**
- Mid-crawl crashes produce duplicate entries
- No recovery path; must clean DB and restart entire crawl

**Implementation:**
- Add `crawl_url_state` table: `pending | fetched | embedded | failed`
- Make chunk writes idempotent (upsert keyed on URL + chunk hash)
- On restart, skip `embedded`, retry `failed`

---

### Phase 2: Re-vectorization Without Re-crawl

**Scope:** Allow reprocessing existing chunks with new embedding settings.

**Problems solved:**
- Can't change embedding provider (e.g., OpenAI → Ollama) without re-crawling
- Re-crawling is slow and abusive to source sites

**Implementation:**
- Add to `archon_sources`:
  ```sql
  embedding_model TEXT,
  embedding_dimensions INTEGER,
  vectorizer_flags JSONB,
  summarization_model TEXT
  ```
- Add "Reprocess" action to re-embed without re-fetching

---

### Phase 3: Per-Source Provenance UI

**Scope:** Display processing metadata for each source in UI.

**Deliverable:**
- UI panel showing: embedding model used, dimensions, vectorizer flags, crawl timestamp

---

### Phase 4 (Optional): robots.txt Enforcement

**Scope:** Respect `Disallow:` directives in robots.txt files.

**Note:** Currently only reads robots.txt for sitemap discovery, doesn't enforce crawl rules. Lower priority - can revisit later.

---

## Consequences

- Resumable crawls prevent data loss and reduce site abuse
- Re-vectorization enables switching embedding providers without re-crawling
- Provenance UI helps debug embedding issues

---

## Future: Git Integration

With a resumable, reprocessable pipeline in place, Git integration becomes the next major feature (separate ADR).
