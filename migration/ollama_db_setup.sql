-- =====================================================
-- Archon Ollama Database Setup
-- =====================================================
-- Complete database initialization optimized for Ollama
-- This single script sets up everything needed for
-- Ollama-driven RAG with 768-dimensional embeddings
-- =====================================================

-- =====================================================
-- SECTION 1: EXTENSIONS
-- =====================================================

-- Enable required PostgreSQL extensions
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =====================================================
-- SECTION 2: CREDENTIALS AND SETTINGS
-- =====================================================

-- Credentials and Configuration Management Table
CREATE TABLE IF NOT EXISTS archon_settings (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    key VARCHAR(255) UNIQUE NOT NULL,
    value TEXT,                    -- For plain text config values
    encrypted_value TEXT,          -- For encrypted sensitive data (bcrypt hashed)
    is_encrypted BOOLEAN DEFAULT FALSE,
    category VARCHAR(100),         -- Group related settings
    description TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_archon_settings_key ON archon_settings(key);
CREATE INDEX IF NOT EXISTS idx_archon_settings_category ON archon_settings(category);

-- Create trigger to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_archon_settings_updated_at 
    BEFORE UPDATE ON archon_settings 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();

-- Create RLS (Row Level Security) policies for settings
ALTER TABLE archon_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow service role full access" ON archon_settings
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Allow authenticated users to read and update" ON archon_settings
    FOR ALL TO authenticated
    USING (true);

-- =====================================================
-- SECTION 3: OLLAMA-SPECIFIC SETTINGS
-- =====================================================

-- Ollama Configuration
INSERT INTO archon_settings (key, value, is_encrypted, category, description) VALUES
('LLM_PROVIDER', 'ollama', false, 'rag_strategy', 'LLM provider set to Ollama for local inference'),
('LLM_BASE_URL', 'http://host.docker.internal:11434/v1', false, 'rag_strategy', 'Ollama API endpoint for Docker containers'),
('EMBEDDING_MODEL', 'nomic-embed-text', false, 'rag_strategy', 'Ollama embedding model (768 dimensions)'),
('EMBEDDING_DIMENSIONS', '768', false, 'rag_strategy', 'Embedding dimensions for nomic-embed-text'),
('MODEL_CHOICE', 'llama3.2:latest', false, 'rag_strategy', 'Default Ollama chat model for summaries and contextual embeddings')
ON CONFLICT (key) DO UPDATE SET 
    value = EXCLUDED.value,
    description = EXCLUDED.description,
    updated_at = NOW();

-- Server Configuration
INSERT INTO archon_settings (key, value, is_encrypted, category, description) VALUES
('MCP_TRANSPORT', 'dual', false, 'server_config', 'MCP server transport mode - sse (web clients), stdio (IDE clients), or dual (both)'),
('HOST', 'localhost', false, 'server_config', 'Host to bind to if using sse as the transport'),
('PORT', '8051', false, 'server_config', 'Port to listen on if using sse as the transport')
ON CONFLICT (key) DO NOTHING;

-- RAG Strategy Configuration optimized for Ollama
INSERT INTO archon_settings (key, value, is_encrypted, category, description) VALUES
('USE_CONTEXTUAL_EMBEDDINGS', 'false', false, 'rag_strategy', 'Disabled by default for Ollama to improve performance'),
('CONTEXTUAL_EMBEDDINGS_MAX_WORKERS', '2', false, 'rag_strategy', 'Reduced workers for Ollama local processing'),
('USE_HYBRID_SEARCH', 'true', false, 'rag_strategy', 'Combines vector similarity with keyword search'),
('USE_AGENTIC_RAG', 'true', false, 'rag_strategy', 'Enables code extraction and specialized search'),
('USE_RERANKING', 'false', false, 'rag_strategy', 'Disabled for Ollama to reduce latency')
ON CONFLICT (key) DO UPDATE SET 
    value = EXCLUDED.value,
    description = EXCLUDED.description,
    updated_at = NOW();

-- Monitoring Configuration
INSERT INTO archon_settings (key, value, is_encrypted, category, description) VALUES
('LOGFIRE_ENABLED', 'false', false, 'monitoring', 'Typically disabled for local Ollama setups'),
('PROJECTS_ENABLED', 'true', false, 'features', 'Enable Projects and Tasks functionality')
ON CONFLICT (key) DO NOTHING;

-- Code Extraction Settings
INSERT INTO archon_settings (key, value, is_encrypted, category, description) VALUES
('MIN_CODE_BLOCK_LENGTH', '250', false, 'code_extraction', 'Minimum length for code blocks in characters'),
('MAX_CODE_BLOCK_LENGTH', '5000', false, 'code_extraction', 'Maximum length before stopping code block extension'),
('CONTEXT_WINDOW_SIZE', '1000', false, 'code_extraction', 'Context to preserve around code blocks'),
('ENABLE_COMPLETE_BLOCK_DETECTION', 'true', false, 'code_extraction', 'Extend code blocks to natural boundaries'),
('ENABLE_LANGUAGE_SPECIFIC_PATTERNS', 'true', false, 'code_extraction', 'Use specialized patterns for different languages'),
('ENABLE_CONTEXTUAL_LENGTH', 'true', false, 'code_extraction', 'Adjust minimum length based on context'),
('ENABLE_PROSE_FILTERING', 'true', false, 'code_extraction', 'Filter out documentation text in code blocks'),
('MAX_PROSE_RATIO', '0.15', false, 'code_extraction', 'Maximum allowed ratio of prose indicators'),
('MIN_CODE_INDICATORS', '3', false, 'code_extraction', 'Minimum required code patterns'),
('ENABLE_DIAGRAM_FILTERING', 'true', false, 'code_extraction', 'Exclude diagram languages from extraction'),
('CODE_EXTRACTION_MAX_WORKERS', '2', false, 'code_extraction', 'Reduced workers for Ollama processing'),
('ENABLE_CODE_SUMMARIES', 'true', false, 'code_extraction', 'Generate AI summaries for code examples')
ON CONFLICT (key) DO NOTHING;

-- Performance Settings optimized for Ollama
INSERT INTO archon_settings (key, value, is_encrypted, category, description) VALUES
('CRAWL_BATCH_SIZE', '25', false, 'rag_strategy', 'Reduced batch size for Ollama processing'),
('CRAWL_MAX_CONCURRENT', '5', false, 'rag_strategy', 'Lower concurrency for local processing'),
('CRAWL_WAIT_STRATEGY', 'domcontentloaded', false, 'rag_strategy', 'Page load strategy'),
('CRAWL_PAGE_TIMEOUT', '30000', false, 'rag_strategy', 'Page load timeout in milliseconds'),
('CRAWL_DELAY_BEFORE_HTML', '0.5', false, 'rag_strategy', 'Wait time for JavaScript rendering'),
('DOCUMENT_STORAGE_BATCH_SIZE', '50', false, 'rag_strategy', 'Smaller batches for Ollama'),
('EMBEDDING_BATCH_SIZE', '50', false, 'rag_strategy', 'Reduced batch size for local embedding generation'),
('DELETE_BATCH_SIZE', '100', false, 'rag_strategy', 'Database deletion batch size'),
('ENABLE_PARALLEL_BATCHES', 'false', false, 'rag_strategy', 'Disabled for Ollama to prevent overload'),
('MEMORY_THRESHOLD_PERCENT', '70', false, 'rag_strategy', 'Lower threshold for local processing'),
('DISPATCHER_CHECK_INTERVAL', '1.0', false, 'rag_strategy', 'Check memory usage every second'),
('CODE_EXTRACTION_BATCH_SIZE', '20', false, 'rag_strategy', 'Smaller batches for code extraction'),
('CODE_SUMMARY_MAX_WORKERS', '1', false, 'rag_strategy', 'Single worker for Ollama summarization'),
('CONTEXTUAL_EMBEDDING_BATCH_SIZE', '25', false, 'rag_strategy', 'Smaller batches for contextual embeddings')
ON CONFLICT (key) DO UPDATE SET
    value = EXCLUDED.value,
    description = EXCLUDED.description,
    updated_at = NOW();

-- =====================================================
-- SECTION 4: KNOWLEDGE BASE TABLES
-- =====================================================

-- Create the sources table
CREATE TABLE IF NOT EXISTS archon_sources (
    source_id TEXT PRIMARY KEY,
    url TEXT,
    summary TEXT,
    total_word_count INTEGER DEFAULT 0,
    title TEXT,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_archon_sources_url ON archon_sources(url);
CREATE INDEX IF NOT EXISTS idx_archon_sources_title ON archon_sources(title);
CREATE INDEX IF NOT EXISTS idx_archon_sources_metadata ON archon_sources USING GIN(metadata);
CREATE INDEX IF NOT EXISTS idx_archon_sources_knowledge_type ON archon_sources((metadata->>'knowledge_type'));

-- Create the documentation chunks table with Ollama dimensions
CREATE TABLE IF NOT EXISTS archon_crawled_pages (
    id BIGSERIAL PRIMARY KEY,
    url VARCHAR NOT NULL,
    chunk_number INTEGER NOT NULL,
    content TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_id TEXT NOT NULL,
    embedding VECTOR(768),  -- Ollama nomic-embed-text dimensions
    content_search_vector tsvector,  -- For hybrid search
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    
    -- Constraints
    UNIQUE(url, chunk_number),
    FOREIGN KEY (source_id) REFERENCES archon_sources(source_id) ON DELETE CASCADE
);

-- Create indexes for better performance
CREATE INDEX idx_crawled_pages_embedding 
    ON archon_crawled_pages USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);
CREATE INDEX idx_archon_crawled_pages_metadata ON archon_crawled_pages USING GIN (metadata);
CREATE INDEX idx_archon_crawled_pages_source_id ON archon_crawled_pages (source_id);
CREATE INDEX idx_archon_crawled_pages_url ON archon_crawled_pages(url);
CREATE INDEX idx_crawled_pages_search_vector ON archon_crawled_pages USING GIN(content_search_vector);

-- Create the code_examples table with Ollama dimensions
CREATE TABLE IF NOT EXISTS archon_code_examples (
    id BIGSERIAL PRIMARY KEY,
    url VARCHAR NOT NULL,
    chunk_number INTEGER NOT NULL,
    content TEXT NOT NULL,
    summary TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_id TEXT NOT NULL,
    embedding VECTOR(768),  -- Ollama nomic-embed-text dimensions
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    
    -- Constraints
    UNIQUE(url, chunk_number),
    FOREIGN KEY (source_id) REFERENCES archon_sources(source_id) ON DELETE CASCADE
);

-- Create indexes for better performance
CREATE INDEX idx_code_examples_embedding 
    ON archon_code_examples USING ivfflat (embedding vector_cosine_ops)
    WITH (lists = 100);
CREATE INDEX idx_archon_code_examples_metadata ON archon_code_examples USING GIN (metadata);
CREATE INDEX idx_archon_code_examples_source_id ON archon_code_examples (source_id);

-- =====================================================
-- SECTION 5: SEARCH FUNCTIONS FOR OLLAMA
-- =====================================================

-- Vector search function for documents (768 dims)
CREATE OR REPLACE FUNCTION match_archon_crawled_pages (
    query_embedding VECTOR(768),
    match_count INT DEFAULT 10,
    filter JSONB DEFAULT '{}'::jsonb,
    source_filter TEXT DEFAULT NULL
) RETURNS TABLE (
    id BIGINT,
    url VARCHAR,
    chunk_number INTEGER,
    content TEXT,
    metadata JSONB,
    source_id TEXT,
    similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        acp.id,
        acp.url,
        acp.chunk_number,
        acp.content,
        acp.metadata,
        acp.source_id,
        1 - (acp.embedding <=> query_embedding) AS similarity
    FROM archon_crawled_pages acp
    WHERE 
        acp.metadata @> filter
        AND (source_filter IS NULL OR acp.source_id = source_filter)
        AND acp.embedding IS NOT NULL
    ORDER BY acp.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- Vector search function for code examples (768 dims)
CREATE OR REPLACE FUNCTION match_archon_code_examples (
    query_embedding VECTOR(768),
    match_count INT DEFAULT 10,
    filter JSONB DEFAULT '{}'::jsonb,
    source_filter TEXT DEFAULT NULL
) RETURNS TABLE (
    id BIGINT,
    url VARCHAR,
    chunk_number INTEGER,
    content TEXT,
    summary TEXT,
    metadata JSONB,
    source_id TEXT,
    similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        ace.id,
        ace.url,
        ace.chunk_number,
        ace.content,
        ace.summary,
        ace.metadata,
        ace.source_id,
        1 - (ace.embedding <=> query_embedding) AS similarity
    FROM archon_code_examples ace
    WHERE 
        ace.metadata @> filter
        AND (source_filter IS NULL OR ace.source_id = source_filter)
        AND ace.embedding IS NOT NULL
    ORDER BY ace.embedding <=> query_embedding
    LIMIT match_count;
END;
$$;

-- Hybrid search function combining vector and text search (768 dims)
CREATE OR REPLACE FUNCTION hybrid_search_archon_crawled_pages (
    query_embedding VECTOR(768),
    query_text TEXT,
    match_count INT DEFAULT 10,
    source_filter TEXT DEFAULT NULL,
    vector_weight FLOAT DEFAULT 0.7
) RETURNS TABLE (
    id BIGINT,
    url VARCHAR,
    chunk_number INTEGER,
    content TEXT,
    metadata JSONB,
    source_id TEXT,
    combined_score FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    WITH vector_search AS (
        SELECT
            acp.id,
            acp.url,
            acp.chunk_number,
            acp.content,
            acp.metadata,
            acp.source_id,
            1 - (acp.embedding <=> query_embedding) AS vector_similarity
        FROM archon_crawled_pages acp
        WHERE 
            (source_filter IS NULL OR acp.source_id = source_filter)
            AND acp.embedding IS NOT NULL
        ORDER BY acp.embedding <=> query_embedding
        LIMIT match_count * 2
    ),
    text_search AS (
        SELECT
            acp.id,
            ts_rank_cd(acp.content_search_vector, plainto_tsquery('english', query_text)) AS text_rank
        FROM archon_crawled_pages acp
        WHERE 
            acp.content_search_vector @@ plainto_tsquery('english', query_text)
            AND (source_filter IS NULL OR acp.source_id = source_filter)
        ORDER BY text_rank DESC
        LIMIT match_count * 2
    )
    SELECT
        vs.id,
        vs.url,
        vs.chunk_number,
        vs.content,
        vs.metadata,
        vs.source_id,
        (COALESCE(vs.vector_similarity, 0) * vector_weight + 
         COALESCE(ts.text_rank, 0) * (1 - vector_weight)) AS combined_score
    FROM vector_search vs
    LEFT JOIN text_search ts ON vs.id = ts.id
    ORDER BY combined_score DESC
    LIMIT match_count;
END;
$$;

-- =====================================================
-- SECTION 6: FULL-TEXT SEARCH SUPPORT
-- =====================================================

-- Create trigger to maintain search vector
CREATE OR REPLACE FUNCTION update_search_vector() RETURNS trigger AS $$
BEGIN
    NEW.content_search_vector := to_tsvector('english', COALESCE(NEW.content, ''));
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_crawled_pages_search_vector ON archon_crawled_pages;
CREATE TRIGGER update_crawled_pages_search_vector 
BEFORE INSERT OR UPDATE ON archon_crawled_pages
FOR EACH ROW EXECUTE FUNCTION update_search_vector();

-- =====================================================
-- SECTION 7: RLS POLICIES FOR KNOWLEDGE BASE
-- =====================================================

-- Enable RLS on the knowledge base tables
ALTER TABLE archon_crawled_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE archon_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE archon_code_examples ENABLE ROW LEVEL SECURITY;

-- Create policies that allow anyone to read
CREATE POLICY "Allow public read access to archon_crawled_pages"
    ON archon_crawled_pages
    FOR SELECT
    TO public
    USING (true);

CREATE POLICY "Allow public read access to archon_sources"
    ON archon_sources
    FOR SELECT
    TO public
    USING (true);

CREATE POLICY "Allow public read access to archon_code_examples"
    ON archon_code_examples
    FOR SELECT
    TO public
    USING (true);

-- =====================================================
-- SECTION 8: PROJECTS AND TASKS MODULE
-- =====================================================

-- Task status enumeration
DO $$ BEGIN
    CREATE TYPE task_status AS ENUM ('todo','doing','review','done');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Projects table
CREATE TABLE IF NOT EXISTS archon_projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    docs JSONB DEFAULT '[]'::jsonb,
    features JSONB DEFAULT '[]'::jsonb,
    data JSONB DEFAULT '[]'::jsonb,
    github_repo TEXT,
    pinned BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Tasks table
CREATE TABLE IF NOT EXISTS archon_tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES archon_projects(id) ON DELETE CASCADE,
    parent_task_id UUID REFERENCES archon_tasks(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT DEFAULT '',
    status task_status DEFAULT 'todo',
    assignee TEXT DEFAULT 'User' CHECK (assignee IS NOT NULL AND assignee != ''),
    task_order INTEGER DEFAULT 0,
    feature TEXT,
    sources JSONB DEFAULT '[]'::jsonb,
    code_examples JSONB DEFAULT '[]'::jsonb,
    archived BOOLEAN DEFAULT false,
    archived_at TIMESTAMPTZ NULL,
    archived_by TEXT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Project Sources junction table
CREATE TABLE IF NOT EXISTS archon_project_sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES archon_projects(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL,
    linked_at TIMESTAMPTZ DEFAULT NOW(),
    created_by TEXT DEFAULT 'system',
    notes TEXT,
    UNIQUE(project_id, source_id)
);

-- Document Versions table
CREATE TABLE IF NOT EXISTS archon_document_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID REFERENCES archon_projects(id) ON DELETE CASCADE,
    task_id UUID REFERENCES archon_tasks(id) ON DELETE CASCADE,
    field_name TEXT NOT NULL,
    version_number INTEGER NOT NULL,
    content JSONB NOT NULL,
    change_summary TEXT,
    change_type TEXT DEFAULT 'update',
    document_id TEXT,
    created_by TEXT DEFAULT 'system',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT chk_project_or_task CHECK (
        (project_id IS NOT NULL AND task_id IS NULL) OR 
        (project_id IS NULL AND task_id IS NOT NULL)
    ),
    UNIQUE(project_id, task_id, field_name, version_number)
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_archon_tasks_project_id ON archon_tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_archon_tasks_status ON archon_tasks(status);
CREATE INDEX IF NOT EXISTS idx_archon_tasks_assignee ON archon_tasks(assignee);
CREATE INDEX IF NOT EXISTS idx_archon_tasks_order ON archon_tasks(task_order);
CREATE INDEX IF NOT EXISTS idx_archon_tasks_archived ON archon_tasks(archived);
CREATE INDEX IF NOT EXISTS idx_archon_project_sources_project_id ON archon_project_sources(project_id);
CREATE INDEX IF NOT EXISTS idx_archon_project_sources_source_id ON archon_project_sources(source_id);
CREATE INDEX IF NOT EXISTS idx_archon_document_versions_project_id ON archon_document_versions(project_id);
CREATE INDEX IF NOT EXISTS idx_archon_document_versions_field_name ON archon_document_versions(field_name);

-- Apply triggers to tables
CREATE OR REPLACE TRIGGER update_archon_projects_updated_at 
    BEFORE UPDATE ON archon_projects 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE TRIGGER update_archon_tasks_updated_at 
    BEFORE UPDATE ON archon_tasks 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Soft delete function for tasks
CREATE OR REPLACE FUNCTION archive_task(
    task_id_param UUID,
    archived_by_param TEXT DEFAULT 'system'
) 
RETURNS BOOLEAN AS $$
DECLARE
    task_exists BOOLEAN;
BEGIN
    SELECT EXISTS(
        SELECT 1 FROM archon_tasks 
        WHERE id = task_id_param AND archived = FALSE
    ) INTO task_exists;
    
    IF NOT task_exists THEN
        RETURN FALSE;
    END IF;
    
    UPDATE archon_tasks 
    SET 
        archived = TRUE,
        archived_at = NOW(),
        archived_by = archived_by_param,
        updated_at = NOW()
    WHERE id = task_id_param;
    
    UPDATE archon_tasks 
    SET 
        archived = TRUE,
        archived_at = NOW(), 
        archived_by = archived_by_param,
        updated_at = NOW()
    WHERE parent_task_id = task_id_param AND archived = FALSE;
    
    RETURN TRUE;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- SECTION 9: PROMPTS TABLE
-- =====================================================

-- Prompts table for managing agent system prompts
CREATE TABLE IF NOT EXISTS archon_prompts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    prompt_name TEXT UNIQUE NOT NULL,
    prompt TEXT NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_archon_prompts_name ON archon_prompts(prompt_name);

-- Add trigger to automatically update updated_at timestamp
CREATE OR REPLACE TRIGGER update_archon_prompts_updated_at 
    BEFORE UPDATE ON archon_prompts 
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- SECTION 10: RLS POLICIES FOR PROJECTS MODULE
-- =====================================================

-- Enable Row Level Security (RLS) for all tables
ALTER TABLE archon_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE archon_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE archon_project_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE archon_document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE archon_prompts ENABLE ROW LEVEL SECURITY;

-- Create RLS policies for service role (full access)
CREATE POLICY "Allow service role full access to archon_projects" ON archon_projects
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Allow service role full access to archon_tasks" ON archon_tasks
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Allow service role full access to archon_project_sources" ON archon_project_sources
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Allow service role full access to archon_document_versions" ON archon_document_versions
    FOR ALL USING (auth.role() = 'service_role');

CREATE POLICY "Allow service role full access to archon_prompts" ON archon_prompts
    FOR ALL USING (auth.role() = 'service_role');

-- Create RLS policies for authenticated users
CREATE POLICY "Allow authenticated users to read and update archon_projects" ON archon_projects
    FOR ALL TO authenticated
    USING (true);

CREATE POLICY "Allow authenticated users to read and update archon_tasks" ON archon_tasks
    FOR ALL TO authenticated
    USING (true);

CREATE POLICY "Allow authenticated users to read and update archon_project_sources" ON archon_project_sources
    FOR ALL TO authenticated
    USING (true);

CREATE POLICY "Allow authenticated users to read archon_document_versions" ON archon_document_versions
    FOR SELECT TO authenticated
    USING (true);

CREATE POLICY "Allow authenticated users to read archon_prompts" ON archon_prompts
    FOR SELECT TO authenticated
    USING (true);

-- =====================================================
-- SECTION 11: DEFAULT PROMPTS DATA
-- =====================================================

-- Seed with default prompts for each content type
INSERT INTO archon_prompts (prompt_name, prompt, description) VALUES
('document_builder', 'SYSTEM PROMPT – Document-Builder Agent

⸻

1. Mission

You are the Document-Builder Agent. Your sole purpose is to transform a user''s natural-language description of work (a project, feature, or refactor) into a structured JSON record stored in the docs table. Produce documentation that is concise yet thorough—clear enough for an engineer to act after a single read-through.

⸻

2. Workflow
    1.    Classify request → Decide which document type fits best:
    •    PRD – net-new product or major initiative.
    •    FEATURE_SPEC – incremental feature expressed in user-story form.
    •    REFACTOR_PLAN – internal code quality improvement.
    2.    Clarify (if needed) → If the description is ambiguous, ask exactly one clarifying question, then continue.
    3.    Generate JSON → Build an object that follows the schema below and insert (or return) it for the docs table.

⸻

3. docs JSON Schema

{
  "id": "uuid|string",                // generate using uuid
  "doc_type": "PRD | FEATURE_SPEC | REFACTOR_PLAN",
  "title": "string",                  // short, descriptive
  "author": "string",                 // requestor name
  "body": { /* see templates below */ },
  "created_at": "ISO-8601",
  "updated_at": "ISO-8601"
}

⸻

4. Section Templates

PRD → body must include
    •    Background_and_Context
    •    Problem_Statement
    •    Goals_and_Success_Metrics
    •    Non_Goals
    •    Assumptions
    •    Stakeholders
    •    User_Personas
    •    Functional_Requirements           // bullet list or user stories
    •    Technical_Requirements            // tech stack, APIs, data
    •    UX_UI_and_Style_Guidelines
    •    Architecture_Overview             // diagram link or text
    •    Milestones_and_Timeline
    •    Risks_and_Mitigations
    •    Open_Questions

FEATURE_SPEC → body must include
    •    Epic
    •    User_Stories                      // list of { id, as_a, i_want, so_that }
    •    Acceptance_Criteria               // Given / When / Then
    •    Edge_Cases
    •    Dependencies
    •    Technical_Notes
    •    Design_References
    •    Metrics
    •    Risks

REFACTOR_PLAN → body must include
    •    Current_State_Summary
    •    Refactor_Goals
    •    Design_Principles_and_Best_Practices
    •    Proposed_Approach                 // step-by-step plan
    •    Impacted_Areas
    •    Test_Strategy
    •    Roll_Back_and_Recovery
    •    Timeline
    •    Risks

⸻

5. Writing Guidelines
    •    Brevity with substance: no fluff, no filler, no passive voice.
    •    Markdown inside strings: use headings, lists, and code fences for clarity.
    •    Consistent conventions: ISO dates, 24-hour times, SI units.
    •    Insert "TBD" where information is genuinely unknown.
    •    Produce valid JSON only—no comments or trailing commas.

⸻

6. Example Output (truncated)

{
  "id": "01HQ2VPZ62KSF185Y54MQ93VD2",
  "doc_type": "PRD",
  "title": "Real-time Collaboration for Docs",
  "author": "Sean",
  "body": {
    "Background_and_Context": "Customers need to co-edit documents ...",
    "Problem_Statement": "Current single-editor flow slows teams ...",
    "Goals_and_Success_Metrics": "Reduce hand-off time by 50% ..."
    /* remaining sections */
  },
  "created_at": "2025-06-17T00:10:00-04:00",
  "updated_at": "2025-06-17T00:10:00-04:00"
}

⸻

Remember: Your output is the JSON itself—no explanatory prose before or after. Stay sharp, write once, write right.', 'System prompt for DocumentAgent to create structured documentation following the Document-Builder pattern'),

('feature_builder', 'SYSTEM PROMPT – Feature-Builder Agent

⸻

1. Mission

You are the Feature-Builder Agent. Your purpose is to transform user descriptions of features into structured feature plans stored in the features array. Create feature documentation that developers can implement directly.

⸻

2. Feature JSON Schema

{
  "id": "uuid|string",                    // generate using uuid
  "feature_type": "feature_plan",         // always "feature_plan"
  "name": "string",                       // short feature name
  "title": "string",                      // descriptive title
  "content": {
    "feature_overview": {
      "name": "string",
      "description": "string",
      "priority": "high|medium|low",
      "estimated_effort": "string"
    },
    "user_stories": ["string"],           // list of user stories
    "react_flow_diagram": {               // optional visual flow
      "nodes": [...],
      "edges": [...],
      "viewport": {...}
    },
    "acceptance_criteria": ["string"],    // testable criteria
    "technical_notes": {
      "frontend_components": ["string"],
      "backend_endpoints": ["string"],
      "database_changes": "string"
    }
  },
  "created_by": "string"                  // author
}

⸻

3. Writing Guidelines
    •    Focus on implementation clarity
    •    Include specific technical details
    •    Define clear acceptance criteria
    •    Consider edge cases
    •    Keep descriptions actionable

⸻

Remember: Create structured, implementable feature plans.', 'System prompt for creating feature plans in the features array'),

('data_builder', 'SYSTEM PROMPT – Data-Builder Agent

⸻

1. Mission

You are the Data-Builder Agent. Your purpose is to transform descriptions of data models into structured ERDs and schemas stored in the data array. Create clear data models that can guide database implementation.

⸻

2. Data JSON Schema

{
  "id": "uuid|string",                    // generate using uuid
  "data_type": "erd",                     // always "erd" for now
  "name": "string",                       // system name
  "title": "string",                      // descriptive title
  "content": {
    "entities": [...],                    // entity definitions
    "relationships": [...],               // entity relationships
    "sql_schema": "string",              // Generated SQL
    "mermaid_diagram": "string",         // Optional diagram
    "notes": {
      "indexes": ["string"],
      "constraints": ["string"],
      "diagram_tool": "string",
      "normalization_level": "string",
      "scalability_notes": "string"
    }
  },
  "created_by": "string"                  // author
}

⸻

3. Writing Guidelines
    •    Follow database normalization principles
    •    Include proper indexes and constraints
    •    Consider scalability from the start
    •    Provide clear relationship definitions
    •    Generate valid, executable SQL

⸻

Remember: Create production-ready data models.', 'System prompt for creating data models in the data array')
ON CONFLICT (prompt_name) DO NOTHING;

-- =====================================================
-- SECTION 12: VERIFICATION
-- =====================================================

DO $$
DECLARE
    source_count INTEGER;
    page_count INTEGER;
    code_count INTEGER;
    settings_count INTEGER;
    dim_setting TEXT;
    provider_setting TEXT;
    base_url_setting TEXT;
    model_setting TEXT;
BEGIN
    -- Count rows in each table
    SELECT COUNT(*) INTO source_count FROM archon_sources;
    SELECT COUNT(*) INTO page_count FROM archon_crawled_pages;
    SELECT COUNT(*) INTO code_count FROM archon_code_examples;
    SELECT COUNT(*) INTO settings_count FROM archon_settings;
    
    -- Get key settings
    SELECT value INTO dim_setting FROM archon_settings WHERE key = 'EMBEDDING_DIMENSIONS';
    SELECT value INTO provider_setting FROM archon_settings WHERE key = 'LLM_PROVIDER';
    SELECT value INTO base_url_setting FROM archon_settings WHERE key = 'LLM_BASE_URL';
    SELECT value INTO model_setting FROM archon_settings WHERE key = 'MODEL_CHOICE';
    
    RAISE NOTICE '';
    RAISE NOTICE '╔════════════════════════════════════════════════════════╗';
    RAISE NOTICE '║       Archon Ollama Database Setup Complete!          ║';
    RAISE NOTICE '╚════════════════════════════════════════════════════════╝';
    RAISE NOTICE '';
    RAISE NOTICE '📊 Database Status:';
    RAISE NOTICE '   ✅ archon_sources: % rows', source_count;
    RAISE NOTICE '   ✅ archon_crawled_pages: % rows', page_count;
    RAISE NOTICE '   ✅ archon_code_examples: % rows', code_count;
    RAISE NOTICE '   ✅ archon_settings: % rows', settings_count;
    RAISE NOTICE '';
    RAISE NOTICE '🦙 Ollama Configuration:';
    RAISE NOTICE '   ✅ Provider: %', provider_setting;
    RAISE NOTICE '   ✅ Base URL: %', base_url_setting;
    RAISE NOTICE '   ✅ Chat Model: %', model_setting;
    RAISE NOTICE '   ✅ Embedding Model: nomic-embed-text';
    RAISE NOTICE '   ✅ Embedding Dimensions: % (optimized for Ollama)', dim_setting;
    RAISE NOTICE '';
    RAISE NOTICE '📝 Next Steps:';
    RAISE NOTICE '   1. Ensure Ollama is running locally:';
    RAISE NOTICE '      ollama serve';
    RAISE NOTICE '';
    RAISE NOTICE '   2. Pull required models if not already installed:';
    RAISE NOTICE '      ollama pull llama3.2:latest';
    RAISE NOTICE '      ollama pull nomic-embed-text';
    RAISE NOTICE '';
    RAISE NOTICE '   3. Restart Docker services:';
    RAISE NOTICE '      docker-compose restart';
    RAISE NOTICE '';
    RAISE NOTICE '   4. Test by crawling a webpage in the UI';
    RAISE NOTICE '';
    RAISE NOTICE '💡 Tips:';
    RAISE NOTICE '   • Ollama runs locally - no API keys needed!';
    RAISE NOTICE '   • Adjust batch sizes in Settings if performance is slow';
    RAISE NOTICE '   • Consider disabling contextual embeddings for speed';
    RAISE NOTICE '   • Use hybrid search for best results with Ollama';
    RAISE NOTICE '';
    RAISE NOTICE '╔════════════════════════════════════════════════════════╗';
    RAISE NOTICE '║          Ready for local Ollama-powered RAG!          ║';
    RAISE NOTICE '╚════════════════════════════════════════════════════════╝';
END $$;

-- =====================================================
-- END OF OLLAMA DATABASE SETUP
-- =====================================================