# ADR-001: Restartable RAG Ingestion Pipeline

## Status: Proposed

## Date: 2026-02-22

## Context

The current RAG ingestion pipeline in Archon is monolithic:
- Download → chunk → embed → summarize happen in a single combined flow
- No checkpointing between stages - if embedding fails mid-batch, entire job must restart
- Embedding metadata is incomplete - no version tracking, config tracking, or prompt tracking
- No support for multiple embedding models or summarization styles per source

This limits:
- Restartability: failures require full re-crawl
- Experimentation: can't A/B test different embedders or prompts
- Sharing: no way to know what produced a knowledge store

## Decision

We will implement a state-machine-style pipeline with explicit stages:

### Database Changes
- New tables: `archon_document_blobs`, `archon_chunks`, `archon_embedding_sets`, `archon_embeddings`, `archon_summaries`
- Each stage has explicit status: `pending` → `in_progress` → `done` | `failed`
- Full metadata tracking for embeddings (embedder_id, version, config) and summaries (model, prompt_hash, style)

### Pipeline Flow
1. **Download** → Store raw content in `archon_document_blobs` (status: downloaded)
2. **Chunk** → Store chunked content in `archon_chunks` with offsets
3. **Queue** → Create `EmbeddingSet` (status: pending) and `Summary` (status: pending)
4. **Workers** → Separate async workers process embedding/summarization passes

### Benefits
- Each stage can be retried independently
- Multiple embedders can coexist for same source (different `EmbeddingSet` records)
- Multiple summaries with different prompts/styles can coexist
- Health checks can validate pipeline state
- Future-proof for Git/IPFS sources (abstract source_type)

## Consequences

### Positive
- Fully restartable pipeline with checkpointing
- Support for A/B testing embedders and prompts
- Clear metadata for reproducibility
- Health checks for data quality validation

### Negative
- More complex schema (5 new tables)
- Migration required for existing deployments
- New pipeline is clean break - old crawls continue with old pipeline

## Alternatives Considered

1. **Extend existing tables** - Rejected: would create messy dual storage with columns + new tables
2. **Event-driven pipeline** - Rejected: adds complexity of message queue; database-driven is simpler for this use case
3. **Keep monolithic** - Rejected: doesn't solve the core problems

## Implementation Notes

- Migration: `migration/0.1.0/014_add_pipeline_tables.sql`
- Services: `python/src/server/services/ingestion/`
  - `ingestion_state_service.py` - State management
  - `pipeline_orchestrator.py` - Main orchestration
  - `embedding_worker.py` - Async embedding processor
  - `summary_worker.py` - Async summarization processor
  - `health_check.py` - Health validation

## Future Considerations

- Git repository source type (source_type = 'git')
- IPFS integration for shared content/embeddings
- Streaming pipeline for very large sources
