# SPEC PRP: RAG Configuration UI Enhancement

## Current State Assessment

### Files Currently Involved
- **UI**: `archon-ui-main/src/components/settings/RAGSettings.tsx`
- **Backend Services**:
  - `python/src/server/services/storage/document_storage_service.py`
  - `python/src/server/services/crawling/document_storage_operations.py`
  - `python/src/server/services/embeddings/embedding_service.py`
  - `python/src/server/services/credential_service.py`
- **Configuration**: `.env` file (EMBEDDING_DIMENSIONS=3072)

### Current Behavior
1. **Hardcoded Settings**:
   - Chunk size: Fixed at 5000 characters in `document_storage_operations.py:97`
   - Chunk overlap: Not configurable (appears to be minimal/none)
   - Minimum chunk size: Not enforced
   - Embedding model: Not exposed in UI (defaults to text-embedding-3-large)
   - Similarity threshold: UI shows only 0-50% range (needs 0-100%)

2. **What IS Configurable in UI**:
   - LLM Provider selection (OpenAI/Google/Ollama)
   - Contextual embeddings on/off
   - Hybrid search on/off
   - Reranking on/off
   - Crawling batch sizes
   - Storage batch sizes

3. **Pain Points**:
   - Cannot adjust chunk size for different document types
   - Cannot set chunk overlap for better context preservation
   - Cannot filter small/noisy chunks
   - Cannot change embedding model without env variable
   - Similarity threshold limited to 50% max in UI
   - No way to configure deduplication thresholds
   - No visibility into current embedding dimensions

## Desired State

### Files to Modify/Create
```yaml
modified_files:
  - archon-ui-main/src/components/settings/RAGSettings.tsx
  - python/src/server/api_routes/credentials_api.py
  - python/src/server/services/storage/document_storage_service.py
  - python/src/server/services/crawling/document_storage_operations.py
  - python/src/server/services/credential_service.py

new_files:
  - archon-ui-main/src/components/settings/AdvancedRAGSettings.tsx
  - python/src/server/services/rag_config_service.py
```

### Target Functionality
1. **Full UI Control** for all RAG parameters
2. **Dynamic chunking** based on document type
3. **Adaptive settings** that can be changed without restart
4. **Validation** to prevent invalid configurations
5. **Presets** for common use cases

### Benefits
- Better search quality through tuned parameters
- Reduced storage costs with optimal chunk sizes
- Improved deduplication
- Faster experimentation with settings
- No code changes needed for optimization

## Hierarchical Objectives

### High-Level Goal
Enable complete RAG configuration control through the UI with intelligent defaults and validation

### Mid-Level Milestones
1. **Backend Configuration Service** - Centralized RAG config management
2. **Enhanced UI Components** - Full-featured settings interface
3. **Dynamic Application** - Settings take effect without restart
4. **Validation & Presets** - Safe configuration with templates

### Low-Level Tasks with Validation

## Task Specifications

### Task 1: Create RAG Configuration Service
```yaml
task_name: create_rag_config_service
  action: CREATE
  file: python/src/server/services/rag_config_service.py
  changes: |
    - Create RagConfigService class
    - Methods: get_config(), update_config(), validate_config()
    - Store in credential_service for persistence
    - Default values:
      * chunk_size: 5000
      * chunk_overlap: 200
      * min_chunk_size: 100
      * max_chunk_size: 10000
      * embedding_model: "text-embedding-3-large"
      * embedding_dimensions: 3072
      * similarity_threshold: 0.7
      * deduplication_threshold: 0.95
  validation:
    - command: "python -m pytest tests/test_rag_config_service.py"
    - expect: "All tests passed"
```

### Task 2: Update Document Storage to Use Config
```yaml
task_name: update_document_storage_operations
  action: MODIFY
  file: python/src/server/services/crawling/document_storage_operations.py
  changes: |
    - Import rag_config_service
    - Replace hardcoded chunk_size=5000 with:
      config = await rag_config_service.get_config()
      chunks = await storage_service.smart_chunk_text_async(
          markdown_content, 
          chunk_size=config['chunk_size'],
          chunk_overlap=config['chunk_overlap'],
          min_size=config['min_chunk_size']
      )
  validation:
    - command: "grep -n 'chunk_size=5000' document_storage_operations.py"
    - expect: "No matches found"
```

### Task 3: Fix Similarity Threshold UI Range
```yaml
task_name: fix_similarity_threshold_range
  action: MODIFY  
  file: archon-ui-main/src/components/settings/RAGSettings.tsx
  changes: |
    - Find similarity threshold slider component
    - Change max value from 50 to 100
    - Update step size if needed (0.05 for 5% increments)
    - Add percentage display label
  validation:
    - command: "grep -A 5 'similarityThreshold' RAGSettings.tsx | grep max"
    - expect: "max={100}"
```

### Task 4: Create Advanced RAG Settings Component
```yaml
task_name: create_advanced_rag_settings
  action: CREATE
  file: archon-ui-main/src/components/settings/AdvancedRAGSettings.tsx
  changes: |
    - Create component with sections:
      * Chunking Configuration
        - Chunk size slider (1000-10000)
        - Overlap slider (0-500)
        - Min chunk filter (50-500)
      * Embedding Configuration
        - Model selector dropdown
        - Dimensions display (read-only)
        - Batch size control
      * Search Configuration  
        - Similarity threshold (0-100%)
        - Deduplication threshold (0-100%)
        - Result count limits
      * Presets dropdown:
        - "Technical Docs" (8000/200/100)
        - "Short Content" (2000/100/50)
        - "Code Heavy" (6000/300/200)
        - "Custom"
  validation:
    - command: "npm run type-check"
    - expect: "No TypeScript errors"
```

### Task 5: Add API Endpoints for Config
```yaml
task_name: add_config_api_endpoints
  action: MODIFY
  file: python/src/server/api_routes/credentials_api.py
  changes: |
    - Add GET /api/credentials/rag-config endpoint
    - Add PUT /api/credentials/rag-config endpoint
    - Add POST /api/credentials/rag-config/validate endpoint
    - Connect to rag_config_service
  validation:
    - command: "curl http://localhost:8181/api/credentials/rag-config"
    - expect: "200 OK with config JSON"
```

### Task 6: Update smart_chunk_text to Accept Parameters
```yaml
task_name: update_smart_chunk_text
  action: MODIFY
  file: python/src/server/services/storage/base_storage_service.py
  changes: |
    - Update smart_chunk_text() signature:
      def smart_chunk_text(
          self, 
          text: str, 
          chunk_size: int = None,
          chunk_overlap: int = None,
          min_size: int = None
      ):
    - Use config service defaults if None
    - Implement overlap logic
    - Filter chunks below min_size
  validation:
    - command: "python -m pytest tests/test_chunking.py"
    - expect: "Chunking with overlap tests pass"
```

## Implementation Strategy

### Order of Implementation
1. **Backend First** (Tasks 1, 2, 6)
   - Create config service
   - Update chunking logic
   - Ensure backward compatibility

2. **API Layer** (Task 5)
   - Add endpoints
   - Test with Postman/curl

3. **UI Enhancement** (Tasks 3, 4)
   - Fix immediate issue (similarity threshold)
   - Add advanced settings panel

4. **Testing & Validation**
   - Unit tests for each component
   - Integration test with sample documents
   - Performance comparison before/after

### Dependencies
- Task 2 depends on Task 1 (config service)
- Task 4 depends on Task 5 (API endpoints)
- Task 6 should be done before Task 2

### Rollback Plan
- All changes use feature flags in config
- Old hardcoded values remain as fallbacks
- Can disable advanced UI with single toggle

## Risk Assessment

### Identified Risks
1. **Breaking existing ingestion** - Mitigate with thorough testing
2. **Performance impact** - Benchmark with different settings
3. **Invalid configurations** - Strict validation rules
4. **Storage increase** - Monitor with different chunk sizes

### Go/No-Go Criteria
- [ ] All unit tests passing
- [ ] Chunking produces same output with default settings
- [ ] UI loads without errors
- [ ] Can ingest a test document successfully
- [ ] Settings persist across restart

## User Interaction Points

### Configuration Validation
- Warn if chunk_size < 1000 (too small)
- Warn if overlap > chunk_size/2 (excessive)
- Prevent min_size > chunk_size
- Show estimated storage impact

### Visual Feedback
- Show example chunking on sample text
- Display current vs recommended settings
- Progress indicator during re-indexing

## Integration Points
- Credential service for persistence
- Document storage for chunking
- Embedding service for model selection
- Search service for similarity threshold

## Quality Checklist
- [x] Current state fully documented
- [x] Desired state clearly defined
- [x] All objectives measurable
- [x] Tasks ordered by dependency
- [x] Each task has validation that AI can run
- [x] Risks identified with mitigations
- [x] Rollback strategy included
- [x] Integration points noted

## Next Steps
1. Review this specification with user
2. Confirm priority of features
3. Decide on implementation timeline
4. Begin with backend config service

---
*Remember: Focus on making RAG configuration accessible and powerful without requiring code changes.*