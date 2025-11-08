# LLM Services

This directory contains LLM integration services for Archon, including Claude with prompt caching support.

## Services

### Claude Service (`claude_service.py`)

Anthropic Claude integration with prompt caching support for 90% cost savings on repeated context.

**Features:**
- Async message creation
- Streaming support
- Prompt caching with ephemeral cache control
- Automatic usage tracking and logging

**Usage:**

```python
from src.server.services.llm.claude_service import get_claude_service

service = get_claude_service()
await service.initialize()

# Create a message with caching
response = await service.create_message(
    messages=[{"role": "user", "content": "What is Python?"}],
    system="You are a helpful programming assistant.",
    use_caching=True  # Enable prompt caching
)

print(response["content"])
print(f"Cache savings: {response['usage']['cache_read_tokens']} tokens")
```

### Model Router (`model_router.py`)

Intelligent model routing for cost optimization based on query complexity and context size.

**Features:**
- Automatic model selection based on task type
- Context-aware routing (Haiku for simple, Sonnet for complex)
- RAG-optimized selection with caching benefits

**Usage:**

```python
from src.server.services.llm.model_router import get_model_router

router = get_model_router()

# Select model for RAG query
provider, model = router.select_model_for_rag(
    query="What is machine learning?",
    context_length=3000,
    enable_caching=True
)

print(f"Using {provider} with {model}")
```

### Answer Generation Service (`answer_generation_service.py`)

High-level service for generating answers from search results using LLMs with prompt caching.

**Features:**
- Context building from search results
- Automatic provider selection
- Source citation in answers
- Cost savings tracking

**Usage:**

```python
from src.server.services.llm.answer_generation_service import get_answer_generation_service

service = get_answer_generation_service()

search_results = [
    {"content": "Python is...", "url": "https://example.com/python"},
    {"content": "Python features...", "url": "https://example.com/features"}
]

result = await service.generate_answer(
    query="What is Python?",
    search_results=search_results,
    use_claude=True,
    enable_caching=True
)

print(result["answer"])
print(f"Cost savings: {result['cost_savings']}%")
```

## Prompt Caching

Anthropic's prompt caching allows you to cache large contexts (system prompts, documentation, code) for 90% cost reduction on cached tokens.

### How it Works

1. **First Request**: Claude processes the full context and caches it
   - Regular input token pricing applies
   - Cache is stored for 5 minutes

2. **Subsequent Requests**: Claude reads from cache
   - 90% cost reduction on cached tokens
   - Only new content (user query) is processed at full price

### Best Practices

1. **Use for Repeated Context**: RAG queries with same documentation
2. **Cache System Prompts**: Stable instructions that don't change
3. **Batch Similar Queries**: Process multiple questions against same context
4. **Monitor Usage**: Track `cache_read_tokens` vs `cache_creation_tokens`

### Example Savings

```
Without Caching:
- 1000 context tokens × 100 queries = 100,000 tokens
- Cost: ~$0.30

With Caching:
- First query: 1000 tokens (full price)
- Next 99 queries: 1000 tokens × 0.1 (cached price) = 990 tokens
- Total: 1,990 tokens vs 100,000 tokens
- Cost: ~$0.006 (98% savings!)
```

## Configuration

### Environment Variables

Add to `.env`:

```bash
ANTHROPIC_API_KEY=sk-ant-...
CLAUDE_MODEL=claude-3-5-sonnet-20241022
ENABLE_CLAUDE_CACHING=true
```

Or configure via Settings page in the UI (recommended).

### Models Available

- `claude-3-5-sonnet-20241022`: Best for complex reasoning, coding, RAG
- `claude-3-haiku-20240307`: Fast and cheap for simple queries
- `claude-3-opus-20240229`: Most capable for difficult tasks

## Testing

Run the test suite:

```bash
# Set API key
export ANTHROPIC_API_KEY=sk-ant-...

# Run tests
cd python
uv run pytest tests/test_claude_integration.py -v

# Or run manually
uv run python tests/test_claude_integration.py
```

## Integration Points

### RAG Queries

The answer generation service is designed to work with Archon's RAG pipeline:

1. User submits query
2. RAG service retrieves relevant documents
3. Answer generation service uses Claude with caching to generate answer
4. Context is cached for 5 minutes for similar queries

### Cost Optimization

The model router automatically selects the most cost-effective model:

- Simple queries + small context → Claude Haiku
- Complex queries + large context → Claude Sonnet with caching
- Maximum cost savings through intelligent routing

## Architecture

```
┌─────────────────────┐
│  Answer Generation  │
│      Service        │
└──────────┬──────────┘
           │
    ┌──────┴──────┐
    │             │
┌───▼────┐   ┌───▼────┐
│ Claude │   │ Model  │
│Service │   │ Router │
└────────┘   └────────┘
```

## Future Enhancements

- [ ] Add OpenAI integration for fallback
- [ ] Implement conversation history support
- [ ] Add multi-model comparison mode
- [ ] Track and report cost savings metrics
- [ ] Add support for Claude's extended thinking mode
