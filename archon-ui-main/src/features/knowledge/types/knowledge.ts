/**
 * Knowledge Base Types
 * Matches backend models from knowledge_api.py
 */

export interface KnowledgeItemMetadata {
  knowledge_type?: "technical" | "business";
  tags?: string[];
  source_type?: "url" | "file" | "group";
  status?: "active" | "processing" | "error";
  description?: string;
  last_scraped?: string;
  chunks_count?: number;
  word_count?: number;
  file_name?: string;
  file_type?: string;
  page_count?: number;
  update_frequency?: number;
  next_update?: string;
  group_name?: string;
  original_url?: string;
  document_count?: number; // Number of documents in this knowledge item
  code_examples_count?: number; // Number of code examples found
}

export interface KnowledgeItem {
  id: string;
  title: string;
  url: string;
  source_id: string;
  source_type: "url" | "file";
  knowledge_type: "technical" | "business";
  status: "active" | "processing" | "error" | "completed";
  document_count: number;
  code_examples_count: number;
  metadata: KnowledgeItemMetadata;
  created_at: string;
  updated_at: string;
}

export interface CodeExampleMetadata {
  language?: string;
  file_path?: string;
  summary?: string;
  relevance_score?: number;
  // No additional flexible properties - use strict typing
}

export interface CodeExample {
  id: number;
  source_id: string;
  content: string; // The actual code content (primary field from backend)
  code?: string; // Alternative field name for backward compatibility
  summary?: string;
  // Fields extracted from metadata by backend API
  title?: string; // AI-generated descriptive name (e.g. "Prepare Multiple Tool Definitions")
  example_name?: string; // Same as title, kept for backend compatibility
  language?: string; // Programming language
  file_path?: string; // Path to the original file
  // Original metadata field (for backward compatibility)
  metadata?: CodeExampleMetadata;
}

export interface DocumentChunkMetadata {
  title?: string;
  section?: string;
  relevance_score?: number;
  url?: string;
  tags?: string[];
  // No additional flexible properties - use strict typing
}

export interface DocumentChunk {
  id: string;
  source_id: string;
  content: string;
  url?: string;
  // Fields extracted from metadata by backend API
  title?: string; // filename or first header
  section?: string; // formatted headers for display
  source_type?: string;
  knowledge_type?: string;
  // Original metadata field (for backward compatibility)
  metadata?: DocumentChunkMetadata;
}

export interface GroupedKnowledgeItem {
  id: string;
  title: string;
  domain: string;
  items: KnowledgeItem[];
  metadata: KnowledgeItemMetadata;
  created_at: string;
  updated_at: string;
}

// API Response types
export interface KnowledgeItemsResponse {
  items: KnowledgeItem[];
  total: number;
  page: number;
  per_page: number;
}

export interface ChunksResponse {
  success: boolean;
  source_id: string;
  domain_filter?: string | null;
  chunks: DocumentChunk[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface CodeExamplesResponse {
  success: boolean;
  source_id: string;
  code_examples: CodeExample[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

// Request types
export interface KnowledgeItemsFilter {
  knowledge_type?: "technical" | "business";
  tags?: string[];
  source_type?: "url" | "file";
  search?: string;
  page?: number;
  per_page?: number;
}

export interface CrawlRequest {
  url: string;
  knowledge_type?: "technical" | "business";
  tags?: string[];
  update_frequency?: number;
  max_depth?: number;
  extract_code_examples?: boolean;
}

export interface UploadMetadata {
  knowledge_type?: "technical" | "business";
  tags?: string[];
}

export interface SearchOptions {
  query: string;
  knowledge_type?: "technical" | "business";
  sources?: string[];
  limit?: number;
}

// UI-specific types
export type KnowledgeViewMode = "grid" | "table";

// Inspector specific types
export interface InspectorSelectedItem {
  type: "document" | "code";
  id: string;
  content: string;
  metadata?: DocumentChunkMetadata | CodeExampleMetadata;
}

// Response from crawl/upload start
export interface CrawlStartResponse {
  success: boolean;
  progressId: string;
  message: string;
  estimatedDuration?: string;
}

export interface RefreshResponse {
  progressId: string;
  message: string;
}

// Search response types
export interface SearchResultsResponse {
  results: DocumentChunk[];
  total: number;
  query: string;
  knowledge_type?: "technical" | "business";
}

// Knowledge sources response
export interface KnowledgeSource {
  id: string;
  name: string;
  domain?: string;
  source_type: "url" | "file";
  knowledge_type: "technical" | "business";
  status: "active" | "processing" | "error";
  document_count: number;
  created_at: string;
  updated_at: string;
}
