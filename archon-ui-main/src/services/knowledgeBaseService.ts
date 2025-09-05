/**
 * Knowledge Base service for managing documentation sources
 */

// Types
export interface KnowledgeItemMetadata {
  knowledge_type?: 'technical' | 'business'
  tags?: string[]
  source_type?: 'url' | 'file'
  status?: 'active' | 'processing' | 'error'
  description?: string
  last_scraped?: string
  chunks_count?: number
  word_count?: number
  file_name?: string
  file_type?: string
  page_count?: number
  update_frequency?: number
  next_update?: string
  group_name?: string
  original_url?: string
}

export interface KnowledgeItem {
  id: string
  title: string
  url: string
  source_id: string
  metadata: KnowledgeItemMetadata
  created_at: string
  updated_at: string
  code_examples?: any[] // Code examples from backend
}

export interface KnowledgeItemsResponse {
  items: KnowledgeItem[]
  total: number
  page: number
  per_page: number
}

export interface KnowledgeItemsFilter {
  knowledge_type?: 'technical' | 'business'
  tags?: string[]
  source_type?: 'url' | 'file'
  search?: string
  page?: number
  per_page?: number
}

export interface CrawlRequest {
  url: string
  knowledge_type?: 'technical' | 'business'
  tags?: string[]
  update_frequency?: number
  max_depth?: number
  crawl_options?: {
    max_concurrent?: number
  }
}

export interface UploadMetadata {
  knowledge_type?: 'technical' | 'business'
  tags?: string[]
}

export interface SearchOptions {
  knowledge_type?: 'technical' | 'business'
  sources?: string[]
  limit?: number
}

// Use relative URL to go through Vite proxy
import { API_BASE_URL } from '../config/api';
// const API_BASE_URL = '/api'; // Now imported from config

// Helper function for API requests with timeout
async function apiRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${API_BASE_URL}${endpoint}`;
  console.log(`🔍 [KnowledgeBase] Starting API request to: ${url}`);
  console.log(`🔍 [KnowledgeBase] Request method: ${options.method || 'GET'}`);
  console.log(`🔍 [KnowledgeBase] API_BASE_URL: "${API_BASE_URL}"`);
  
  // Create an AbortController for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    console.error(`⏰ [KnowledgeBase] Request timeout after 10 seconds for: ${url}`);
    controller.abort();
  }, 10000); // 10 second timeout
  
  try {
    console.log(`🚀 [KnowledgeBase] Sending fetch request...`);
    const response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      },
      ...options,
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    console.log(`✅ [KnowledgeBase] Response received:`, response.status, response.statusText);
    console.log(`✅ [KnowledgeBase] Response headers:`, response.headers);

    if (!response.ok) {
      console.error(`❌ [KnowledgeBase] Response not OK: ${response.status} ${response.statusText}`);
      const error = await response.json();
      console.error(`❌ [KnowledgeBase] API error response:`, error);
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    const data = await response.json();
    console.log(`✅ [KnowledgeBase] Response data received, type: ${typeof data}`);
    return data;
  } catch (error) {
    clearTimeout(timeoutId);
    console.error(`❌ [KnowledgeBase] Request failed:`, error);
    console.error(`❌ [KnowledgeBase] Error name: ${error instanceof Error ? error.name : 'Unknown'}`);
    console.error(`❌ [KnowledgeBase] Error message: ${error instanceof Error ? error.message : String(error)}`);
    console.error(`❌ [KnowledgeBase] Error stack:`, error instanceof Error ? error.stack : 'No stack');
    
    // Check if it's a timeout error
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Request timed out after 10 seconds');
    }
    
    throw error;
  }
}

class KnowledgeBaseService {
  /**
   * Get knowledge items with optional filtering
   */
  async getKnowledgeItems(filter: KnowledgeItemsFilter = {}): Promise<KnowledgeItemsResponse> {
    console.log('📋 [KnowledgeBase] Getting knowledge items with filter:', filter);
    
    const params = new URLSearchParams()
    
    // Add default pagination
    params.append('page', String(filter.page || 1))
    params.append('per_page', String(filter.per_page || 20))
    
    // Add optional filters
    if (filter.knowledge_type) params.append('knowledge_type', filter.knowledge_type)
    if (filter.tags && filter.tags.length > 0) params.append('tags', filter.tags.join(','))
    if (filter.source_type) params.append('source_type', filter.source_type)
    if (filter.search) params.append('search', filter.search)
    
    const queryString = params.toString();
    console.log('📋 [KnowledgeBase] Query string:', queryString);
    console.log('📋 [KnowledgeBase] Full endpoint:', `/knowledge-items?${queryString}`);
    
    const response = await apiRequest<KnowledgeItemsResponse>(`/knowledge-items?${params}`)
    
    // Debug logging to inspect response
    console.log('📋 [KnowledgeBase] Response received:', response);
    console.log('📋 [KnowledgeBase] Total items:', response.items?.length);
    
    // Check if any items have code_examples
    const itemsWithCodeExamples = response.items?.filter(item => item.code_examples && item.code_examples.length > 0) || [];
    console.log('📋 [KnowledgeBase] Items with code examples:', itemsWithCodeExamples.length);
    
    // Log details for modelcontextprotocol.io
    const mcpItem = response.items?.find(item => item.source_id === 'modelcontextprotocol.io');
    if (mcpItem) {
      console.log('📋 [KnowledgeBase] MCP item found:', mcpItem);
      console.log('📋 [KnowledgeBase] MCP code_examples:', mcpItem.code_examples);
    }
    
    return response
  }

  /**
   * Delete a knowledge item by source_id
   */
  async deleteKnowledgeItem(sourceId: string) {
    return apiRequest(`/knowledge-items/${sourceId}`, {
      method: 'DELETE'
    })
  }

  /**
   * Update knowledge item metadata
   */
  async updateKnowledgeItem(sourceId: string, updates: Partial<KnowledgeItemMetadata>) {
    return apiRequest(`/knowledge-items/${sourceId}`, {
      method: 'PUT',
      body: JSON.stringify(updates)
    })
  }

  /**
   * Refresh a knowledge item by re-crawling its URL
   */
  async refreshKnowledgeItem(sourceId: string) {
    console.log('🔄 [KnowledgeBase] Refreshing knowledge item:', sourceId);
    
    return apiRequest(`/knowledge-items/${sourceId}/refresh`, {
      method: 'POST'
    })
  }

  /**
   * Get document chunks for a knowledge item with optional domain filtering
   */
  async getKnowledgeItemChunks(sourceId: string, domainFilter?: string) {
    console.log('📄 [KnowledgeBase] Getting chunks for:', sourceId, 'domainFilter:', domainFilter);
    
    const params = new URLSearchParams();
    if (domainFilter) {
      params.append('domain_filter', domainFilter);
    }
    
    const queryString = params.toString();
    const endpoint = `/knowledge-items/${sourceId}/chunks${queryString ? `?${queryString}` : ''}`;
    
    return apiRequest<{
      success: boolean;
      source_id: string;
      domain_filter?: string;
      chunks: Array<{
        id: string;
        source_id: string;
        content: string;
        metadata?: any;
        url?: string;
      }>;
      count: number;
    }>(endpoint);
  }

  /**
   * Upload a document to the knowledge base with progress tracking
   */
  async uploadDocument(file: File, metadata: UploadMetadata = {}) {
    const formData = new FormData()
    formData.append('file', file)
    
    // Send fields as expected by backend API
    if (metadata.knowledge_type) {
      formData.append('knowledge_type', metadata.knowledge_type)
    }
    if (metadata.tags && metadata.tags.length > 0) {
      formData.append('tags', JSON.stringify(metadata.tags))
    }
    
    const response = await fetch(`${API_BASE_URL}/documents/upload`, {
      method: 'POST',
      body: formData
    })

    if (!response.ok) {
      const error = await response.json()
      throw new Error(error.error || `HTTP ${response.status}`)
    }

    return response.json()
  }

  /**
   * Start crawling a URL with metadata
   */
  async crawlUrl(request: CrawlRequest) {
    console.log('📡 Sending crawl request:', request);
    
    const response = await apiRequest('/knowledge-items/crawl', {
      method: 'POST',
      body: JSON.stringify(request)
    });
    
    console.log('📡 Crawl response received:', response);
    console.log('📡 Response type:', typeof response);
    console.log('📡 Response has progressId?', 'progressId' in (response as any));
    
    return response;
  }

  /**
   * Get detailed information about a knowledge item
   */
  async getKnowledgeItemDetails(sourceId: string) {
    return apiRequest(`/knowledge-items/${sourceId}/details`)
  }

  /**
   * Search across the knowledge base
   */
  async searchKnowledgeBase(query: string, options: SearchOptions = {}) {
    return apiRequest('/knowledge-items/search', {
      method: 'POST',
      body: JSON.stringify({
        query,
        ...options
      })
    })
  }

  /**
   * Stop a running crawl task
   */
  async stopCrawl(progressId: string) {
    console.log('🛑 [KnowledgeBase] Stopping crawl:', progressId);
    
    return apiRequest(`/knowledge-items/stop/${progressId}`, {
      method: 'POST'
    });
  }

  /**
   * Get code examples for a specific knowledge item
   */
  async getCodeExamples(sourceId: string) {
    console.log('📚 [KnowledgeBase] Fetching code examples for:', sourceId);
    
    return apiRequest<{
      success: boolean
      source_id: string
      code_examples: any[]
      count: number
    }>(`/knowledge-items/${sourceId}/code-examples`);
  }

}

// Export singleton instance
export const knowledgeBaseService = new KnowledgeBaseService() 