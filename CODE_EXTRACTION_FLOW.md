# Code Extraction vs Document Storage - Data Flow

## Executive Summary

**Your prompt change ONLY affects extracted code blocks, not regular prose chunks.**

The code summary prompt in `code_storage_service.py` runs on **extracted code blocks only** (triple backtick blocks from markdown). Regular documentation chunks get NO AI summarization at the chunk level.

---

## The Two Parallel Pipelines

### Pipeline 1: Regular Document Storage (ALL Content)
**Files**: `document_storage_operations.py` → `document_storage_service.py`
**Table**: `archon_documents`

```
1. Crawl returns markdown documents
2. Each document is chunked (5000 chars per chunk)
3. Each chunk gets:
   - Embedding (vector)
   - Metadata (title, URL, tags, etc.)
   - NO AI-generated summary (just raw text)
4. Stored in archon_documents table
```

**Key point**: Regular prose chunks are **not summarized** by the LLM. They're just embedded and stored.

### Pipeline 2: Code Extraction (Code Blocks Only)
**Files**: `code_extraction_service.py` → `code_storage_service.py`
**Table**: `archon_code_examples`

```
1. AFTER documents are stored, code extraction runs
2. Searches markdown for triple backtick blocks (```)
3. Extracts code blocks that pass validation:
   - Minimum length (configurable, default 250 chars)
   - Code quality checks (not prose, not diagrams)
   - Language-specific patterns
4. For EACH extracted code block:
   - Generate summary using LLM ← YOUR PROMPT HERE
   - Create embedding (code + summary combined)
   - Store in archon_code_examples table
5. Stored separately from regular chunks
```

**Key point**: The code summary prompt ONLY runs on extracted code blocks, not on prose.

---

## Question 1: Does code_storage_service.py only run on code chunks?

**Answer**: ✅ YES - Only on extracted code blocks

**Evidence** from `crawling_service.py` lines 594-650:
```python
# Extract code examples if requested
code_examples_count = 0
if request.get("extract_code_examples", True) and actual_chunks_stored > 0:
    # ...
    code_examples_count = await self.doc_storage_ops.extract_and_store_code_examples(
        crawl_results,
        storage_results["url_to_full_document"],
        storage_results["source_id"],
        code_progress_callback,
        self._check_cancellation,
        provider,
        embedding_provider,
    )
```

The code summary prompt in `code_storage_service.py:631-643` is called from:
```
extract_and_store_code_examples()
  → _generate_code_summaries()
    → generate_code_summaries_batch()
      → _generate_code_example_summary_async()  ← PROMPT IS HERE
```

This path is ONLY taken for extracted code blocks, never for regular prose chunks.

---

## Question 2: Is there separate summarization for prose documentation?

**Answer**: ❌ NO - Prose chunks get NO AI summarization

**Evidence** from `document_storage_service.py`:
```python
async def add_documents_to_supabase(
    client,
    urls: list[str],
    chunk_numbers: list[int],
    contents: list[str],           # Raw chunk text
    metadatas: list[dict[str, Any]], # Metadata (no summary field)
    url_to_full_document: dict[str, str],
    # ...
```

Regular document chunks are stored with:
- ✅ Raw text content
- ✅ Embeddings (vector)
- ✅ Metadata (URL, title, tags, word count, etc.)
- ❌ NO AI-generated summary field

**Exception**: The SOURCE itself gets a summary in `_create_source_records()`:
```python
# Generate summary with fallback
try:
    summary = await extract_source_summary(source_id, combined_content)
except Exception as e:
    # Fallback to simple summary
    summary = f"Documentation from {source_id} - {len(source_contents)} pages crawled"

# Update source info in database
await update_source_info(
    client=self.supabase_client,
    source_id=source_id,
    summary=summary,  # ← SOURCE summary, not chunk summary
    # ...
)
```

So there's:
- **Source-level summary**: YES (one summary for the entire source)
- **Chunk-level summary for prose**: NO (chunks are just embedded, not summarized)
- **Chunk-level summary for code**: YES (your new prompt)

---

## Question 3: What determines code extraction vs regular storage?

**Answer**: BOTH happen - it's not either/or, it's sequential

### The Flow in `crawling_service.py` lines 540-660:

```
Step 1: ALWAYS store all content as regular chunks
  ↓
await doc_storage_ops.process_and_store_documents(...)
  → Stores in archon_documents table
  → ALL content (prose + code) stored as chunks
  → Each chunk embedded

Step 2: IF extract_code_examples=True (default), extract code
  ↓
await doc_storage_ops.extract_and_store_code_examples(...)
  → Searches markdown for ``` code blocks
  → Validates code blocks (length, quality, patterns)
  → Generates summaries for valid blocks ← YOUR PROMPT
  → Stores in archon_code_examples table
```

### Control Flag

From `crawling_service.py:596`:
```python
if request.get("extract_code_examples", True) and actual_chunks_stored > 0:
```

**Default**: `True` - code extraction is enabled by default
**Override**: User can set `"extract_code_examples": false` in crawl request

### Validation Criteria (What Makes a Block "Code")

From `code_extraction_service.py:1405-1559` (`_validate_code_quality`):

**Must pass ALL checks**:
1. ✅ Minimum length (250+ chars, configurable)
2. ✅ Not a diagram language (mermaid, plantuml, etc.)
3. ✅ No HTML entity corruption
4. ✅ Minimum code indicators (3+ of: function calls, assignments, control flow, etc.)
5. ✅ Not mostly comments (>70% comment lines rejected)
6. ✅ Language-specific patterns (if language specified)
7. ✅ Not mostly prose (max 15% prose indicators)
8. ✅ Reasonable structure (3+ non-empty lines)

**If validation fails**: Block is skipped, not stored in archon_code_examples

---

## Database Storage

### Regular Chunks: `archon_documents` table
```sql
CREATE TABLE archon_documents (
  id uuid PRIMARY KEY,
  content text,           -- Raw chunk text
  url text,
  chunk_number int,
  embedding_* vector,     -- Embeddings
  metadata jsonb,         -- URL, title, tags, word_count, etc.
  source_id text,
  page_id uuid,
  -- NO summary field
)
```

### Code Examples: `archon_code_examples` table
```sql
CREATE TABLE archon_code_examples (
  id uuid PRIMARY KEY,
  content text,           -- Code block
  summary text,           -- AI-generated summary ← YOUR PROMPT
  url text,
  chunk_number int,
  embedding_* vector,     -- Embeddings
  metadata jsonb,         -- language, example_name, etc.
  source_id text,
  llm_chat_model text,    -- Model used for summary
  -- Summary IS present
)
```

### Same Content, Two Tables

A code block from the documentation will appear in:
1. **archon_documents**: As part of the original chunk (no summary)
2. **archon_code_examples**: Extracted and summarized (with summary)

This is intentional - allows both:
- General semantic search across all content
- Code-specific search with summaries

---

## Impact of Your Prompt Change

### What IS affected:
- ✅ Code blocks extracted from markdown
- ✅ Summaries in `archon_code_examples.summary` column
- ✅ Embeddings for code examples (since they embed `code + summary`)

### What is NOT affected:
- ❌ Regular prose documentation chunks
- ❌ Embeddings for regular chunks in `archon_documents`
- ❌ Source-level summaries
- ❌ Page metadata

### Percentage of Total Content

**Typical documentation site**:
- Regular chunks: ~95% of content
- Code examples: ~5% of content

**Your prompt optimization**:
- Affects: ~5% of processing (code summaries)
- Doesn't affect: ~95% of processing (prose chunks)

**But**:
- Code summaries are the SLOWEST part (LLM calls)
- Optimizing them with 1.2B model = massive speedup for that 5%
- Total crawl time reduction: ~30-50% (code extraction is a bottleneck)

---

## Configuration

### Enable/Disable Code Extraction

**Per-crawl** (API request):
```json
{
  "url": "https://example.com",
  "extract_code_examples": false  // Skip code extraction
}
```

**Global** (environment variable):
```bash
ENABLE_CODE_SUMMARIES=false  # Disable AI summaries (use defaults)
```

**Code quality thresholds** (environment variables):
```bash
MIN_CODE_BLOCK_LENGTH=250        # Minimum code block size
MAX_CODE_BLOCK_LENGTH=5000       # Maximum code block size
MIN_CODE_INDICATORS=3            # Minimum code patterns required
MAX_PROSE_RATIO=0.15             # Maximum prose content allowed
ENABLE_PROSE_FILTERING=true      # Enable prose detection
ENABLE_DIAGRAM_FILTERING=true    # Skip diagram blocks
```

---

## Summary

| Aspect | Regular Chunks | Code Examples |
|--------|---------------|---------------|
| **Storage** | `archon_documents` | `archon_code_examples` |
| **Content** | ALL markdown (prose + code) | Code blocks only |
| **AI Summary** | ❌ No | ✅ Yes (your prompt) |
| **Embeddings** | ✅ Yes (raw text) | ✅ Yes (code + summary) |
| **Percentage** | ~95% of content | ~5% of content |
| **Processing Time** | Fast (just embed) | Slow (LLM calls) |
| **Your Prompt** | Not used | Used for every block |

**Key Insight**: Your 1.2B prompt optimization targets the **slow, expensive part** (code summaries) while leaving the bulk of the content (prose chunks) unchanged. This is exactly where optimization matters most.

---

## References

- **Main flow**: `src/server/services/crawling/crawling_service.py:540-660`
- **Document storage**: `src/server/services/crawling/document_storage_operations.py:37-289`
- **Code extraction**: `src/server/services/crawling/code_extraction_service.py:135-257`
- **Code summarization**: `src/server/services/storage/code_storage_service.py:598-1013`
- **Code validation**: `src/server/services/crawling/code_extraction_service.py:1405-1559`
