# ADR-001: Crawl & Ingestion Pipeline Improvements

**Status:** Superseded by ADR-002  
**Date:** 2026-02-22  
**Authors:** Zebastjan Johanzen

> ⚠️ **This ADR has been superseded by ADR-002**. All content has been merged into ADR-002 for a unified view of crawl reliability, provenance tracking, and validation tooling.

---

## Completed ✅

*(These were already completed before ADR-001 was superseded)*

| Feature | Status | Notes |
|---------|--------|-------|
| `CrawlStatus.discovery` enum | ✅ Done | Progress model includes discovery stage |
| Domain filtering | ✅ Done | Both UI controls and backend filtering |
| Priority discovery (llms.txt → sitemap → full) | ✅ Done | DiscoveryService with correct priority order |
| Per-chunk embedding metadata | ✅ Done | `embedding_model`, `embedding_dimension` on `archon_crawled_pages` |
| Chunk deduplication | ✅ Done | Unique constraint on `(url, chunk_number)` |

---

## Remaining Work

*(See ADR-002 for the complete roadmap)*
