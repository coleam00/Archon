# Testing the Restartable RAG Ingestion Pipeline

This document provides manual testing steps for the new restartable pipeline integration.

## Prerequisites

1. Start the backend service:
```bash
cd /home/zebastjan/dev/archon
docker compose up --build -d archon-server
# OR run locally:
# cd python && uv run python -m src.server.main
```

2. Ensure Supabase is running and migration 014 has been applied (pipeline tables exist)

## Test 1: Crawl with New Pipeline Flag

### Step 1: Trigger a crawl with the new pipeline

```bash
curl -X POST http://localhost:8181/api/knowledge/crawl \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://docs.mem0.ai/llms.txt",
    "knowledge_type": "documentation",
    "use_new_pipeline": true
  }'
```

**Expected Response:**
```json
{
  "success": true,
  "progressId": "<uuid>",
  "message": "Crawling started",
  "estimatedDuration": "3-5 minutes"
}
```

### Step 2: Check crawl progress

```bash
# Replace <progress_id> with the ID from step 1
curl http://localhost:8181/api/progress/<progress_id>
```

**Expected:** Status should progress through stages (discovery → downloading → chunking)

### Step 3: Verify pipeline state

Once crawling completes, check that blobs and chunks were created:

```bash
# Get source_id from progress response
SOURCE_ID="<source_id_from_progress>"

# Check health of the source
curl http://localhost:8181/api/ingestion/health/$SOURCE_ID
```

**Expected Response:**
```json
{
  "healthy": true,
  "source_id": "<source_id>",
  "blobs": 1,
  "chunks": 5,
  "embedding_sets": 1,
  "summaries": 1,
  "issues": [],
  "warnings": [
    {
      "type": "embedding_incomplete",
      "embedding_set_id": "<uuid>",
      "status": "pending",
      "message": "Embedding set <uuid> has status pending"
    },
    {
      "type": "no_summaries",
      "message": "No summaries found for source"
    }
  ]
}
```

**Note:** Embeddings and summaries will be "pending" because workers haven't run yet.

## Test 2: Trigger Workers to Process Embeddings

### Step 1: Process pending embeddings

```bash
curl -X POST http://localhost:8181/api/ingestion/process-embeddings
```

**Expected Response:**
```json
{
  "processed": 1,
  "failed": 0,
  "sets_processed": ["<embedding_set_id>"]
}
```

### Step 2: Verify embeddings are done

```bash
curl http://localhost:8181/api/ingestion/health/$SOURCE_ID
```

**Expected:** embedding_sets should now show status "done" instead of "pending"

## Test 3: Trigger Workers to Process Summaries

### Step 1: Process pending summaries

```bash
curl -X POST http://localhost:8181/api/ingestion/process-summaries
```

**Expected Response:**
```json
{
  "processed": 1,
  "failed": 0,
  "summaries_processed": ["<summary_id>"]
}
```

### Step 2: Verify summaries are done

```bash
curl http://localhost:8181/api/ingestion/health/$SOURCE_ID
```

**Expected:**
```json
{
  "healthy": true,
  "source_id": "<source_id>",
  "blobs": 1,
  "chunks": 5,
  "embedding_sets": 1,
  "summaries": 1,
  "issues": [],
  "warnings": []
}
```

## Test 4: Checkpoint/Resume Scenario

### Step 1: Start a crawl with new pipeline

```bash
curl -X POST http://localhost:8181/api/knowledge/crawl \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://docs.mem0.ai/llms-full.txt",
    "use_new_pipeline": true
  }'
```

### Step 2: DON'T trigger workers - simulate interruption

### Step 3: Restart the service

```bash
docker compose restart archon-server
```

### Step 4: Check health - should show pending work

```bash
curl http://localhost:8181/api/ingestion/health/$SOURCE_ID
```

**Expected:** Should show pending embeddings and summaries (data persisted across restart)

### Step 5: Resume processing

```bash
# Trigger workers to complete the pending work
curl -X POST http://localhost:8181/api/ingestion/process-embeddings
curl -X POST http://localhost:8181/api/ingestion/process-summaries
```

### Step 6: Verify completion

```bash
curl http://localhost:8181/api/ingestion/health/$SOURCE_ID
```

**Expected:** Should show healthy with no pending work

## Test 5: CONTRIBUTING.md Required URLs

Test all 4 required URLs per CONTRIBUTING.md:

### 1. llms.txt format

```bash
curl -X POST http://localhost:8181/api/knowledge/crawl \
  -H "Content-Type: application/json" \
  -d '{"url": "https://docs.mem0.ai/llms.txt", "use_new_pipeline": true}'

# Wait for crawl to complete, then:
curl -X POST http://localhost:8181/api/ingestion/process-embeddings
curl -X POST http://localhost:8181/api/ingestion/process-summaries
```

### 2. llms-full.txt format

```bash
curl -X POST http://localhost:8181/api/knowledge/crawl \
  -H "Content-Type: application/json" \
  -d '{"url": "https://docs.mem0.ai/llms-full.txt", "use_new_pipeline": true}'

# Wait for crawl to complete, then:
curl -X POST http://localhost:8181/api/ingestion/process-embeddings
curl -X POST http://localhost:8181/api/ingestion/process-summaries
```

### 3. sitemap.xml format

```bash
curl -X POST http://localhost:8181/api/knowledge/crawl \
  -H "Content-Type: application/json" \
  -d '{"url": "https://mem0.ai/sitemap.xml", "use_new_pipeline": true}'

# Wait for crawl to complete, then:
curl -X POST http://localhost:8181/api/ingestion/process-embeddings
curl -X POST http://localhost:8181/api/ingestion/process-summaries
```

### 4. Normal URL with recursive crawling

```bash
curl -X POST http://localhost:8181/api/knowledge/crawl \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://docs.anthropic.com/en/docs/claude-code/overview",
    "use_new_pipeline": true,
    "max_depth": 2
  }'

# Wait for crawl to complete, then:
curl -X POST http://localhost:8181/api/ingestion/process-embeddings
curl -X POST http://localhost:8181/api/ingestion/process-summaries
```

### Validation Checklist

For each URL test, verify:
- [ ] Crawling completes without errors
- [ ] Blobs created with status "downloaded"
- [ ] Chunks created with proper content
- [ ] Embeddings process successfully (status: done)
- [ ] Summaries process successfully (status: done)
- [ ] Health check passes with no issues
- [ ] MCP search returns results for the indexed content

## Test 6: Retry Failed Jobs

### Simulate a failure

Manually set an embedding set to "failed" in the database:

```sql
UPDATE archon_embedding_sets
SET status = 'failed', error_info = '{"error": "Test failure"}'
WHERE id = '<embedding_set_id>';
```

### Retry the failed job

```bash
curl -X POST http://localhost:8181/api/ingestion/retry-failed-embeddings
```

**Expected Response:**
```json
{
  "reset": 1
}
```

### Process the retried job

```bash
curl -X POST http://localhost:8181/api/ingestion/process-embeddings
```

**Expected:** Should successfully process the previously failed embedding set

## Test 7: Old Pipeline Still Works

Verify backward compatibility - old pipeline should still work without the flag:

```bash
curl -X POST http://localhost:8181/api/knowledge/crawl \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://docs.mem0.ai/llms.txt",
    "use_new_pipeline": false
  }'
```

**Expected:** Should complete using the old monolithic pipeline (embeddings created immediately)

---

## Success Criteria

All tests should pass with:
- ✅ No errors during crawling or processing
- ✅ Data persists across service restarts
- ✅ Health checks accurately reflect pipeline state
- ✅ Workers process pending jobs correctly
- ✅ Retry mechanism works for failed jobs
- ✅ Old pipeline remains functional (backward compatibility)
- ✅ All 4 CONTRIBUTING.md URLs crawl successfully
- ✅ MCP search works for all indexed content

## Troubleshooting

### Issue: "No pending embedding sets"

**Cause:** Workers already processed the jobs or crawl hasn't completed yet.

**Solution:** Check crawl progress, wait for completion, then trigger workers.

### Issue: Health check shows "failed" status

**Cause:** Worker encountered an error during processing.

**Solution:** Check error_info in database, fix issue, use retry endpoint.

### Issue: Old pipeline breaks

**Cause:** Integration changes affected backward compatibility.

**Solution:** Review document_storage_operations.py, ensure use_new_pipeline check is correct.

---

## Next Steps After Manual Testing

1. Create automated integration tests for all scenarios
2. Add UI button to trigger workers
3. Consider adding background scheduler for automatic worker execution
4. Document migration path from old to new pipeline
5. Performance benchmarking: compare old vs new pipeline
