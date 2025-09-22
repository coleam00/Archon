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
  max_depth?: number; // Crawl depth configuration
  crawl_config?: CrawlConfig; // Advanced crawl configuration
  [key: string]: any; // Allow additional untyped fields from backend
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
  // Additional fields that might be at top level
  max_depth?: number;
  tags?: string[];
  crawl_config?: CrawlConfig;
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

/**
 * Advanced crawler configuration for domain and URL pattern filtering.
 *
 * Precedence Rules (highest to lowest priority):
 * 1. excluded_domains - Always blocks, takes highest priority
 * 2. allowed_domains - If specified, only these domains are crawled
 * 3. exclude_patterns - Blocks matching URL patterns
 * 4. include_patterns - If specified, only matching patterns are crawled
 *
 * Pattern Syntax:
 * - Domain patterns: Support wildcards ([star].example.com) and exact matches
 * - URL patterns: Use glob syntax with fnmatch ([star], ?, [seq], [!seq])
 *
 * Common Examples:
 *
 * Example 1 - Crawl only docs subdomain, excluding API references:
 *   allowed_domains: ["docs.example.com"]
 *   exclude_patterns: [[star]/api-reference/[star], [star]/deprecated/[star]]
 *
 * Example 2 - Crawl all subdomains except blog, only documentation paths:
 *   allowed_domains: [[star].example.com]
 *   excluded_domains: ["blog.example.com"]
 *   include_patterns: [[star]/docs/[star], [star]/guide/[star], [star]/tutorial/[star]]
 *
 * Example 3 - Block specific file types across all domains:
 *   exclude_patterns: [[star].pdf, [star].zip, [star]/downloads/[star]]
 */
export interface CrawlConfig {
  /**
   * Whitelist of domains to crawl. Supports exact matches and wildcards.
   * Examples: docs.example.com, [star].example.com, api.example.com
   * If specified, ONLY these domains will be crawled (unless blocked by excluded_domains).
   */
  allowed_domains?: string[];

  /**
   * Blacklist of domains to never crawl. Takes precedence over allowed_domains.
   * Examples: blog.example.com, [star].internal.example.com
   * These domains are ALWAYS blocked, even if they match allowed_domains.
   */
  excluded_domains?: string[];

  /**
   * URL patterns that must match for pages to be crawled. Uses glob syntax.
   * Examples: [star]/docs/[star], [star]/api/v2/[star], [star]tutorial[star]
   * If specified, ONLY URLs matching at least one pattern will be crawled.
   * Patterns are matched against the full URL.
   */
  include_patterns?: string[];

  /**
   * URL patterns to exclude from crawling. Uses glob syntax. Takes precedence over include_patterns.
   * Examples: [star]/admin/[star], [star].pdf, [star]/temp/[star], [star]test[star]
   * URLs matching these patterns are ALWAYS blocked.
   * Patterns are matched against the full URL.
   */
  exclude_patterns?: string[];
}

export interface CrawlRequest {
  url: string;
  knowledge_type?: "technical" | "business";
  tags?: string[];
  update_frequency?: number;
  max_depth?: number;
  extract_code_examples?: boolean;
}

export interface CrawlRequestV2 extends CrawlRequest {
  crawl_config?: CrawlConfig;
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
