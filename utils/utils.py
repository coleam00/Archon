-- Enable the pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Create the documentation chunks table
CREATE TABLE IF NOT EXISTS site_pages (
    id BIGSERIAL PRIMARY KEY,
    url VARCHAR NOT NULL,
    chunk_number INTEGER NOT NULL,
    title VARCHAR NOT NULL,
    summary VARCHAR NOT NULL,
    content TEXT NOT NULL,  -- Added content column
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,  -- Added metadata column
    embedding VECTOR(1536),  -- OpenAI embeddings are 1536 dimensions
    created_at TIMESTAMPTZ DEFAULT timezone('utc', now()) NOT NULL,

    -- Add a unique constraint to prevent duplicate chunks for the same URL
    UNIQUE(url, chunk_number)
);

-- Create an index for better vector similarity search performance
-- Note: PostgreSQL does not support CREATE INDEX IF NOT EXISTS
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'site_pages_embedding_idx'
    ) THEN
        CREATE INDEX site_pages_embedding_idx
        ON site_pages
        USING ivfflat (embedding vector_cosine_ops);
    END IF;
END $$;

-- Create an index on metadata for faster filtering
-- Note: PostgreSQL does not support CREATE INDEX IF NOT EXISTS
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'idx_site_pages_metadata'
    ) THEN
        CREATE INDEX idx_site_pages_metadata
        ON site_pages
        USING gin (metadata);
    END IF;
END $$;

-- Drop the existing function if it exists
DROP FUNCTION IF EXISTS match_site_pages(
    query_embedding VECTOR(1536),
    match_count INT,
    filter JSONB
);

-- Create a function to search for documentation chunks
CREATE FUNCTION match_site_pages (
    query_embedding VECTOR(1536),
    match_count INT DEFAULT 10,
    filter JSONB DEFAULT '{}'::jsonb
) RETURNS TABLE (
    id BIGINT,
    url VARCHAR,
    chunk_number INTEGER,
    title VARCHAR,
    summary VARCHAR,
    content TEXT,
    metadata JSONB,
    similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        id,
        url,
        chunk_number,
        title,
        summary,
        content,
        metadata,
        1 - (site_pages.embedding <=> query_embedding) AS similarity
    FROM site_pages
    WHERE metadata @> filter
    ORDER BY site_pages.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- Enable Row-Level Security (RLS) on the table
ALTER TABLE site_pages ENABLE ROW LEVEL SECURITY;

-- Create a policy that allows anyone to read
CREATE POLICY "Allow public read access"
  ON site_pages
  FOR SELECT
  TO PUBLIC
  USING (true);
