# RAG Architecture Documentation

## Overview

This document describes the Retrieval-Augmented Generation (RAG) architecture used in Archon, a production-ready implementation that combines multiple search strategies for optimal retrieval performance. This architecture has proven highly effective and can be replicated in other projects.

## Architecture Components

### 1. Multi-Strategy Search Pipeline

The system uses a modular approach with four complementary search strategies:

- **Base Vector Search**: Semantic similarity using OpenAI embeddings (1536 dimensions)
- **Hybrid Search**: Combines vector search with PostgreSQL full-text search
- **Reranking**: CrossEncoder models to re-score and improve result ordering
- **Contextual Embeddings**: Enriches chunks with document context before embedding

### 2. Core Components

```
┌─────────────────┐
│   User Query    │
└────────┬────────┘
         │
    ┌────▼────┐
    │Embedding │
    │ Service │
    └────┬────┘
         │
    ┌────▼──────────────────────┐
    │    RAG Service Pipeline    │
    │  ┌──────────────────────┐ │
    │  │ 1. Vector Search     │ │
    │  │ 2. Hybrid Search     │ │
    │  │ 3. Reranking         │ │
    │  └──────────────────────┘ │
    └────────┬──────────────────┘
             │
    ┌────────▼────────┐
    │  PostgreSQL +   │
    │    pgvector     │
    └─────────────────┘
```

## Replication Guide

### Prerequisites

- PostgreSQL 15+ with pgvector extension
- Python 3.11+
- OpenAI API key (or compatible embedding provider)
- Optional: Supabase account (or self-hosted Supabase)

### Step 1: Database Setup

Create the required PostgreSQL extensions and tables:

```sql
-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Create main documents table
CREATE TABLE documents (
    id BIGSERIAL PRIMARY KEY,
    url VARCHAR(2083) NOT NULL,
    chunk_number INTEGER NOT NULL,
    content TEXT NOT NULL,
    embedding vector(1536),
    metadata JSONB DEFAULT '{}',
    source_id TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),

    -- Full-text search column
    content_search_vector tsvector
    GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
);

-- Create indexes for performance
CREATE INDEX idx_documents_embedding ON documents
    USING ivfflat (embedding vector_cosine_ops);
CREATE INDEX idx_documents_search ON documents
    USING GIN (content_search_vector);
CREATE INDEX idx_documents_metadata ON documents
    USING GIN (metadata);

-- Vector search function
CREATE OR REPLACE FUNCTION match_documents(
    query_embedding vector(1536),
    match_count INT DEFAULT 10,
    filter JSONB DEFAULT '{}'
)
RETURNS TABLE (
    id BIGINT,
    url VARCHAR,
    content TEXT,
    metadata JSONB,
    similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        d.id,
        d.url,
        d.content,
        d.metadata,
        1 - (d.embedding <=> query_embedding) AS similarity
    FROM documents d
    WHERE d.metadata @> filter
        AND d.embedding IS NOT NULL
    ORDER BY d.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- Hybrid search function
CREATE OR REPLACE FUNCTION hybrid_search_documents(
    query_embedding vector(1536),
    query_text TEXT,
    match_count INT DEFAULT 10,
    filter JSONB DEFAULT '{}'
)
RETURNS TABLE (
    id BIGINT,
    url VARCHAR,
    content TEXT,
    metadata JSONB,
    similarity FLOAT,
    match_type TEXT
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    WITH vector_results AS (
        SELECT
            d.id,
            d.url,
            d.content,
            d.metadata,
            1 - (d.embedding <=> query_embedding) AS similarity
        FROM documents d
        WHERE d.metadata @> filter
            AND d.embedding IS NOT NULL
        ORDER BY d.embedding <=> query_embedding
        LIMIT match_count
    ),
    text_results AS (
        SELECT
            d.id,
            d.url,
            d.content,
            d.metadata,
            ts_rank_cd(d.content_search_vector,
                      plainto_tsquery('english', query_text)) AS similarity
        FROM documents d
        WHERE d.metadata @> filter
            AND d.content_search_vector @@ plainto_tsquery('english', query_text)
        ORDER BY similarity DESC
        LIMIT match_count
    )
    SELECT
        COALESCE(v.id, t.id) AS id,
        COALESCE(v.url, t.url) AS url,
        COALESCE(v.content, t.content) AS content,
        COALESCE(v.metadata, t.metadata) AS metadata,
        COALESCE(v.similarity, t.similarity) AS similarity,
        CASE
            WHEN v.id IS NOT NULL AND t.id IS NOT NULL THEN 'hybrid'
            WHEN v.id IS NOT NULL THEN 'vector'
            ELSE 'keyword'
        END AS match_type
    FROM vector_results v
    FULL OUTER JOIN text_results t ON v.id = t.id
    ORDER BY similarity DESC
    LIMIT match_count;
END;
$$;
```

### Step 2: Python Dependencies

Install required packages:

```bash
pip install openai supabase sentence-transformers asyncio
```

### Step 3: Core Service Implementation

Create the base embedding service:

```python
# embedding_service.py
import openai
from typing import List, Optional

class EmbeddingService:
    def __init__(self, api_key: str, model: str = "text-embedding-3-small"):
        self.client = openai.OpenAI(api_key=api_key)
        self.model = model

    async def create_embedding(self, text: str) -> List[float]:
        """Create embedding for a single text."""
        response = await self.client.embeddings.create(
            model=self.model,
            input=text,
            dimensions=1536
        )
        return response.data[0].embedding

    async def create_embeddings_batch(
        self,
        texts: List[str],
        batch_size: int = 100
    ) -> List[List[float]]:
        """Create embeddings for multiple texts in batches."""
        embeddings = []

        for i in range(0, len(texts), batch_size):
            batch = texts[i:i + batch_size]
            response = await self.client.embeddings.create(
                model=self.model,
                input=batch,
                dimensions=1536
            )
            embeddings.extend([item.embedding for item in response.data])

        return embeddings
```

Create the RAG service:

```python
# rag_service.py
from typing import List, Dict, Any, Optional
import asyncio
from supabase import create_client

class RAGService:
    def __init__(self, supabase_url: str, supabase_key: str):
        self.client = create_client(supabase_url, supabase_key)
        self.embedding_service = EmbeddingService(api_key="your-api-key")
        self.reranker = None  # Optional: Initialize reranker here

    async def search(
        self,
        query: str,
        match_count: int = 5,
        use_hybrid: bool = False,
        use_reranking: bool = False
    ) -> List[Dict[str, Any]]:
        """
        Main search function combining all strategies.

        Args:
            query: Search query text
            match_count: Number of results to return
            use_hybrid: Enable hybrid search (vector + keyword)
            use_reranking: Enable result reranking

        Returns:
            List of search results
        """
        # Generate query embedding
        query_embedding = await self.embedding_service.create_embedding(query)

        # Fetch more candidates if reranking is enabled
        search_count = match_count * 5 if use_reranking else match_count

        # Perform search
        if use_hybrid:
            results = self._hybrid_search(
                query, query_embedding, search_count
            )
        else:
            results = self._vector_search(
                query_embedding, search_count
            )

        # Apply reranking if enabled
        if use_reranking and self.reranker:
            results = self._rerank_results(query, results, match_count)

        return results[:match_count]

    def _vector_search(
        self,
        query_embedding: List[float],
        match_count: int
    ) -> List[Dict[str, Any]]:
        """Perform vector similarity search."""
        response = self.client.rpc(
            'match_documents',
            {
                'query_embedding': query_embedding,
                'match_count': match_count
            }
        ).execute()
        return response.data

    def _hybrid_search(
        self,
        query: str,
        query_embedding: List[float],
        match_count: int
    ) -> List[Dict[str, Any]]:
        """Perform hybrid search combining vector and text search."""
        response = self.client.rpc(
            'hybrid_search_documents',
            {
                'query_embedding': query_embedding,
                'query_text': query,
                'match_count': match_count
            }
        ).execute()
        return response.data
```

### Step 4: Optional Enhancements

#### A. Contextual Embeddings

Enhance chunks with document context before embedding:

```python
async def generate_contextual_embedding(
    full_document: str,
    chunk: str,
    llm_client: openai.OpenAI
) -> str:
    """Add context to chunk before embedding."""
    prompt = f"""<document>
{full_document[:5000]}
</document>
<chunk>
{chunk}
</chunk>
Please provide a short context to situate this chunk within the document."""

    response = await llm_client.chat.completions.create(
        model="gpt-4",
        messages=[
            {"role": "user", "content": prompt}
        ],
        max_tokens=200
    )

    context = response.choices[0].message.content
    return f"{context}\n---\n{chunk}"
```

#### B. Reranking with CrossEncoder

Add reranking for improved precision:

```python
from sentence_transformers import CrossEncoder

class Reranker:
    def __init__(self, model_name: str = "cross-encoder/ms-marco-MiniLM-L-6-v2"):
        self.model = CrossEncoder(model_name)

    def rerank(
        self,
        query: str,
        results: List[Dict[str, Any]],
        top_k: int = 5
    ) -> List[Dict[str, Any]]:
        """Rerank results using CrossEncoder."""
        # Create query-document pairs
        pairs = [[query, result['content']] for result in results]

        # Get reranking scores
        scores = self.model.predict(pairs)

        # Add scores and sort
        for i, result in enumerate(results):
            result['rerank_score'] = float(scores[i])

        # Sort by rerank score
        results.sort(key=lambda x: x['rerank_score'], reverse=True)

        return results[:top_k]
```

### Step 5: Document Processing Pipeline

Process and store documents with embeddings:

```python
async def process_document(
    document_url: str,
    document_content: str,
    chunk_size: int = 1000,
    chunk_overlap: int = 200
) -> None:
    """Process document and store chunks with embeddings."""

    # 1. Split document into chunks
    chunks = split_into_chunks(document_content, chunk_size, chunk_overlap)

    # 2. Optional: Add context to chunks
    if USE_CONTEXTUAL_EMBEDDINGS:
        chunks = [
            await generate_contextual_embedding(document_content, chunk)
            for chunk in chunks
        ]

    # 3. Generate embeddings
    embeddings = await embedding_service.create_embeddings_batch(chunks)

    # 4. Store in database
    for i, (chunk, embedding) in enumerate(zip(chunks, embeddings)):
        supabase_client.table('documents').insert({
            'url': document_url,
            'chunk_number': i,
            'content': chunk,
            'embedding': embedding,
            'metadata': {'source': 'web'}
        }).execute()
```

### Step 6: Configuration

Create a configuration file for easy tuning:

```python
# config.py
import os

# Embedding settings
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")
EMBEDDING_DIMENSIONS = 1536
EMBEDDING_BATCH_SIZE = 100

# Search settings
USE_HYBRID_SEARCH = os.getenv("USE_HYBRID_SEARCH", "true").lower() == "true"
USE_RERANKING = os.getenv("USE_RERANKING", "true").lower() == "true"
USE_CONTEXTUAL_EMBEDDINGS = os.getenv("USE_CONTEXTUAL_EMBEDDINGS", "false").lower() == "true"

# Similarity threshold
SIMILARITY_THRESHOLD = float(os.getenv("SIMILARITY_THRESHOLD", "0.15"))

# Reranking model
RERANKING_MODEL = os.getenv("RERANKING_MODEL", "cross-encoder/ms-marco-MiniLM-L-6-v2")

# Database
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")
```

## Usage Example

```python
# main.py
import asyncio
from rag_service import RAGService

async def main():
    # Initialize RAG service
    rag = RAGService(
        supabase_url="your-supabase-url",
        supabase_key="your-supabase-key"
    )

    # Perform search
    results = await rag.search(
        query="How to implement OAuth2 authentication?",
        match_count=5,
        use_hybrid=True,
        use_reranking=True
    )

    # Display results
    for result in results:
        print(f"Score: {result['similarity']:.3f}")
        print(f"Content: {result['content'][:200]}...")
        print("---")

if __name__ == "__main__":
    asyncio.run(main())
```

## Performance Optimization

### 1. Indexing
- Use IVFFlat index for large vector datasets (>1M vectors)
- Tune `lists` parameter based on dataset size
- Consider HNSW index for better recall

### 2. Batching
- Process embeddings in batches (100-500 per batch)
- Use semaphores to limit concurrent API calls
- Implement exponential backoff for rate limiting

### 3. Caching
- Cache frequently searched queries
- Store embeddings for common phrases
- Use Redis for query result caching

### 4. Monitoring
- Track embedding generation time
- Monitor search latency
- Log reranking performance impact

## Best Practices

1. **Chunking Strategy**
   - Use overlapping chunks to preserve context
   - Optimal chunk size: 500-1500 tokens
   - Consider sentence boundaries

2. **Error Handling**
   - Never store zero/null embeddings
   - Implement retry logic with backoff
   - Log failures for debugging

3. **Quality Control**
   - Set appropriate similarity thresholds
   - Filter out low-quality matches
   - Validate embeddings before storage

4. **Scalability**
   - Use connection pooling for database
   - Implement async/await throughout
   - Consider distributed processing for large datasets

## Common Issues and Solutions

### Issue: Poor retrieval quality
**Solution**: Enable hybrid search and reranking. Tune similarity threshold.

### Issue: Rate limiting errors
**Solution**: Implement token-based rate limiting with exponential backoff.

### Issue: Slow search performance
**Solution**: Optimize PostgreSQL indexes, reduce embedding dimensions, cache results.

### Issue: High API costs
**Solution**: Use smaller embedding models, batch processing, implement caching.

## Advanced Features

### Code Example Extraction
Extract and index code blocks from documentation:

```python
def extract_code_blocks(markdown: str) -> List[Dict[str, Any]]:
    """Extract code blocks from markdown with language detection."""
    import re

    pattern = r'```(\w+)?\n(.*?)\n```'
    matches = re.findall(pattern, markdown, re.DOTALL)

    code_blocks = []
    for language, code in matches:
        if len(code) > 250:  # Min length threshold
            code_blocks.append({
                'language': language or 'unknown',
                'code': code,
                'summary': generate_code_summary(code)
            })

    return code_blocks
```

### Multi-Modal Search
Combine text and image embeddings for richer search:

```python
async def create_multimodal_embedding(
    text: str,
    image_url: Optional[str] = None
) -> List[float]:
    """Create combined embedding for text and image."""
    text_embedding = await create_embedding(text)

    if image_url:
        image_embedding = await create_image_embedding(image_url)
        # Combine embeddings (various strategies possible)
        combined = (text_embedding + image_embedding) / 2
        return combined

    return text_embedding
```

## Conclusion

This RAG architecture provides a robust foundation for semantic search applications. The modular design allows you to start simple with vector search and progressively add hybrid search, reranking, and contextual embeddings as needed. The system has been battle-tested in production and handles millions of documents efficiently.

Key success factors:
- Multiple retrieval strategies working together
- Robust error handling and recovery
- Flexible configuration without code changes
- Performance optimization at every layer

Start with the basic setup and add enhancements based on your specific requirements and scale.