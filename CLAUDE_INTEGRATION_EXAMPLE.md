# Claude Integration Example

This document demonstrates how to use the Claude integration with prompt caching for RAG queries.

## Quick Start

### 1. Install Dependencies

```bash
cd python
uv sync --group all
```

### 2. Configure API Key

Add to `.env` or configure via Settings page:

```bash
ANTHROPIC_API_KEY=sk-ant-api03-...your-key-here...
```

### 3. Basic Usage

```python
from src.server.services.llm.claude_service import get_claude_service

# Initialize service
service = get_claude_service()
await service.initialize()

# Create a simple message
response = await service.create_message(
    messages=[
        {"role": "user", "content": "Explain Python in one sentence."}
    ],
    max_tokens=100
)

print(response["content"])
```

## RAG Query with Prompt Caching

Here's how to use Claude for RAG queries with 90% cost savings through prompt caching:

```python
from src.server.services.llm.answer_generation_service import get_answer_generation_service

# Get the service
answer_service = get_answer_generation_service()

# Your search results from RAG
search_results = [
    {
        "content": "Python is a high-level, interpreted programming language...",
        "url": "https://docs.python.org/3/tutorial/index.html"
    },
    {
        "content": "Python supports multiple programming paradigms...",
        "url": "https://docs.python.org/3/faq/general.html"
    }
]

# Generate answer with caching
result = await answer_service.generate_answer(
    query="What is Python and why should I use it?",
    search_results=search_results,
    use_claude=True,
    enable_caching=True
)

print(f"Answer: {result['answer']}")
print(f"\nModel: {result['model']}")
print(f"Cache hit: {result['cache_hit']}")
print(f"Cost savings: {result['cost_savings']}%")
```

## Understanding Prompt Caching

### First Request (Cache Creation)

```python
# First query - creates cache
result1 = await answer_service.generate_answer(
    query="What is Python?",
    search_results=documentation_chunks,
    enable_caching=True
)

# Usage stats:
# - cache_creation_tokens: 3000 (documentation context)
# - cache_read_tokens: 0
# - Cost: ~$0.009 (3000 tokens × $3/MTok)
```

### Subsequent Requests (Cache Hits)

```python
# Second query - reads from cache (same documentation)
result2 = await answer_service.generate_answer(
    query="What are Python decorators?",  # Different question
    search_results=documentation_chunks,   # Same context
    enable_caching=True
)

# Usage stats:
# - cache_creation_tokens: 0
# - cache_read_tokens: 3000 (90% cheaper!)
# - Cost: ~$0.0009 (3000 tokens × $0.30/MTok)
# - Savings: 90%
```

## Real-World Example: Documentation Bot

```python
async def answer_documentation_question(question: str, doc_source: str):
    """Answer questions about documentation with caching."""

    # 1. Search documentation
    from src.server.services.search.rag_service import RAGService

    rag = RAGService()
    success, results = await rag.perform_rag_query(
        query=question,
        source=doc_source,
        match_count=5
    )

    if not success:
        return {"error": "Search failed"}

    # 2. Generate answer with Claude + caching
    answer_service = get_answer_generation_service()

    result = await answer_service.generate_answer(
        query=question,
        search_results=results["results"],
        use_claude=True,
        enable_caching=True
    )

    return {
        "question": question,
        "answer": result["answer"],
        "sources": [r.get("url") for r in results["results"][:3]],
        "cache_hit": result.get("cache_hit", False),
        "cost_savings": result.get("cost_savings", 0)
    }

# Usage
response = await answer_documentation_question(
    question="How do I create a FastAPI route?",
    doc_source="fastapi.tiangolo.com"
)

print(response["answer"])
if response["cache_hit"]:
    print(f"💰 Saved {response['cost_savings']}% on this query!")
```

## Model Selection Strategy

The model router automatically selects the best model:

```python
from src.server.services.llm.model_router import get_model_router

router = get_model_router()

# Simple query, small context → Claude Haiku (fast & cheap)
provider, model = router.select_model_for_rag(
    query="What is X?",
    context_length=500,
    enable_caching=False
)
# Returns: ("claude", "claude-3-haiku-20240307")

# Complex query, large context → Claude Sonnet with caching
provider, model = router.select_model_for_rag(
    query="Explain the architecture and design patterns...",
    context_length=5000,
    enable_caching=True
)
# Returns: ("claude", "claude-3-5-sonnet-20241022")
```

## Cost Comparison

### Without Caching

```
100 RAG queries with 3000 token context each:
- Total tokens: 300,000
- Cost: ~$0.90 (at $3/MTok)
```

### With Caching

```
100 RAG queries with same documentation:
- First query: 3000 tokens × $3/MTok = $0.009
- Next 99 queries: 3000 × 99 × $0.30/MTok = $0.089
- Total cost: $0.098
- Savings: 89% ($0.80 saved!)
```

## API Endpoint Integration

Add to your FastAPI routes:

```python
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from src.server.services.llm.answer_generation_service import get_answer_generation_service

router = APIRouter()

class QuestionRequest(BaseModel):
    question: str
    source: str | None = None

@router.post("/api/ask")
async def ask_question(request: QuestionRequest):
    """Answer a question using RAG + Claude with caching."""

    # Search knowledge base
    from src.server.services.search.rag_service import RAGService
    rag = RAGService()

    success, results = await rag.perform_rag_query(
        query=request.question,
        source=request.source,
        match_count=5
    )

    if not success:
        raise HTTPException(status_code=500, detail="Search failed")

    # Generate answer with Claude
    answer_service = get_answer_generation_service()
    result = await answer_service.generate_answer(
        query=request.question,
        search_results=results["results"],
        use_claude=True,
        enable_caching=True
    )

    return {
        "answer": result["answer"],
        "model": result["model"],
        "sources": results["results"][:3],
        "cache_hit": result.get("cache_hit", False),
        "cost_savings_pct": result.get("cost_savings", 0)
    }
```

## Monitoring and Debugging

### Enable Detailed Logging

```python
import logging

# Set log level
logging.getLogger("src.server.services.llm").setLevel(logging.DEBUG)

# Now you'll see detailed cache stats
```

### Check Cache Performance

```python
response = await service.create_message(...)

usage = response["usage"]
print(f"Input tokens: {usage['input_tokens']}")
print(f"Output tokens: {usage['output_tokens']}")
print(f"Cache creation: {usage['cache_creation_tokens']}")
print(f"Cache read: {usage['cache_read_tokens']}")

if usage['cache_read_tokens'] > 0:
    savings_pct = (usage['cache_read_tokens'] /
                   (usage['cache_read_tokens'] + usage['cache_creation_tokens'])) * 90
    print(f"💰 Saved approximately {savings_pct:.1f}%")
```

## Testing

Run the integration tests:

```bash
# Set API key
export ANTHROPIC_API_KEY=sk-ant-...

# Run tests
cd python
uv run pytest tests/test_claude_integration.py -v -s

# Or run interactively
uv run python tests/test_claude_integration.py
```

## Best Practices

1. **Use caching for repeated context**: Documentation, code examples, system prompts
2. **Batch similar queries**: Process multiple questions against same context within 5 minutes
3. **Monitor cache hits**: Track `cache_read_tokens` to measure savings
4. **Choose right model**: Use router for automatic selection
5. **Handle errors gracefully**: Always have OpenAI fallback

## Common Issues

### API Key Not Found

```
Error: Claude service not available (missing API key)
```

**Solution**: Set `ANTHROPIC_API_KEY` in `.env` or via Settings page

### Cache Not Working

**Check**:
- Using same system prompt for multiple requests?
- Requests within 5-minute cache window?
- `use_caching=True` parameter set?

### Slow Responses

**Tip**: Use Claude Haiku for simple queries to reduce latency:

```python
response = await service.create_message(
    messages=messages,
    model="claude-3-haiku-20240307",  # Faster
    max_tokens=500
)
```

## Next Steps

- Integrate with your RAG pipeline
- Add conversation history support
- Track cost savings metrics
- Set up monitoring dashboard
- Implement A/B testing (Claude vs OpenAI)
