# Archon Roadmap

> Last updated: February 2026
>
> Status: Living document - ideas being hashed out, direction subject to change

---

## Current Focus

### Robust Ingestion Pipeline

Work in progress on creating a solid, reliable data ingestion system.

**Goals:**
- Checkpoints and resume functionality for interrupted crawls
- Restart capability without data loss
- Sanity testing on ingested data
- A/B testing for summaries and vectorizations
- Data quality verification before relying on results

---

## Near-Term

### Batch Processing & Bootstrapping

Enable users to add multiple sources at once rather than one at a time.

**Features:**
- **Pre-flight visibility** - Before starting a batch, show:
  - Estimated data volume (pages, token count)
  - Estimated crawl time
  - Estimated token cost (important for paid providers)
  - Risk assessment (is this going to take a week? cost $1000?)
- **Source quality signals** - Before ingesting, evaluate:
  - Is this a valuable source or low-quality/rubbish?
  - Content density indicators
  - Freshness metrics
- **Background processing** - Run heavy processing when:
  - User is not actively using the system
  - System resources are available
  - During "off hours"

### Agent Skills & Prompt Separation

Extract prompts from hardcoded Python strings into external files for flexibility.

**Features:**
- Extract prompts to `SKILL.md` files (Agent Skills standard)
- Skill loading infrastructure
- Skill management (enable/disable per-project or globally)
- **System visibility** - See which skills are active and running

---

## Mid-Term

### Git Integration

Index local Git repositories for code-aware queries.

**Features:**
- Index local repositories into the knowledge base
- Branch-aware updates (switch branches → content updates)
- Version/rollback support via Git hashes
- File access through Git rather than local filesystem

### IPFS Integration

Shared knowledge bases via IPFS to reduce individual ingestion burden.

**Features:**
- Publish knowledge bases to IPFS
- Pull shared sources from the network
- Community-curated sources (Pydantic docs, database docs, coding patterns)
- Reduces redundant ingestion across users

---

## Long-Term

### Database Abstraction

Support multiple vector databases beyond Supabase.

**Goals:**
- Evaluate alternatives (Quadrant > Weaviate based on research)
- Abstract storage layer for portability
- Migration tools between providers

### Knowledge Graph

Graph-based understanding of code relationships.

**Vision:**
- Understand code dependencies
- Trace feature usage across codebase
- Better answers through relationship understanding

---

## Ideas for Discussion

The following are ideas that have been discussed but not yet prioritized:

1. **Agent-driven source discovery** - AI finds and suggests useful documentation
2. **Security scanning** - Validate sources before ingestion
3. **Collaborative knowledge bases** - Multiple users contribute to shared sources
4. **Custom embeddings** - User-provided embedding models
5. **Real-time sync** - Live updates when source documentation changes

---

## Notes

- Priorities may shift based on user feedback and discovered needs
- Some features depend on others (e.g., Agent Skills before complex debugging visibility)
- This is a living document - update as understanding evolves
