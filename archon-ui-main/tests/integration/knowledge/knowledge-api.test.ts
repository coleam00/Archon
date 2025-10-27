/**
 * Integration tests for Knowledge Base API
 * Tests actual API endpoints with backend
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { knowledgeService } from '../../../src/features/knowledge/services';
import type { KnowledgeItemsResponse, CrawlStartResponse } from '../../../src/features/knowledge/types';

// Skip in CI, only run locally with backend
const skipInCI = process.env.CI ? describe.skip : describe;

skipInCI('Knowledge API Integration', () => {
  let testSourceId: string | null = null;
  let testProgressId: string | null = null;

  beforeAll(() => {
    // Ensure we're testing against local backend
    if (!import.meta.env.DEV) {
      throw new Error('Integration tests should only run in development mode');
    }
  });

  afterAll(async () => {
    // Clean up test data if created
    if (testSourceId) {
      try {
        await knowledgeService.deleteKnowledgeItem(testSourceId);
      } catch (error) {
        console.warn('Failed to clean up test item:', error);
      }
    }
  });

  describe('Knowledge Items', () => {
    it('should fetch knowledge items list', async () => {
      const response = await knowledgeService.getKnowledgeSummaries({
        page: 1,
        per_page: 10,
      });

      expect(response).toHaveProperty('items');
      expect(response).toHaveProperty('total');
      expect(response).toHaveProperty('page');
      expect(response).toHaveProperty('per_page');
      expect(Array.isArray(response.items)).toBe(true);
      expect(response.page).toBe(1);
      expect(response.per_page).toBe(10);
    });

    it('should filter knowledge items by type', async () => {
      const response = await knowledgeService.getKnowledgeSummaries({
        knowledge_type: 'technical',
        page: 1,
        per_page: 5,
      });

      expect(response).toHaveProperty('items');
      expect(Array.isArray(response.items)).toBe(true);
      
      // All items should be technical type if any exist
      response.items.forEach(item => {
        if (item.metadata?.knowledge_type) {
          expect(item.metadata.knowledge_type).toBe('technical');
        }
      });
    });

    it('should handle pagination', async () => {
      const page1 = await knowledgeService.getKnowledgeSummaries({
        page: 1,
        per_page: 2,
      });

      const page2 = await knowledgeService.getKnowledgeSummaries({
        page: 2,
        per_page: 2,
      });

      expect(page1.page).toBe(1);
      expect(page2.page).toBe(2);
      expect(page1.per_page).toBe(2);
      expect(page2.per_page).toBe(2);
    });
  });

  describe('Crawl Operations', () => {
    it('should start a crawl and return progress ID', async () => {
      const response = await knowledgeService.crawlUrl({
        url: 'https://example.com/test',
        knowledge_type: 'technical',
        tags: ['test'],
        max_depth: 1,
      });

      expect(response).toHaveProperty('progressId');
      expect(response).toHaveProperty('message');
      expect(response.success).toBe(true);
      expect(typeof response.progressId).toBe('string');
      
      testProgressId = response.progressId;

      // Clean up - stop the crawl
      if (testProgressId) {
        try {
          await knowledgeService.stopCrawl(testProgressId);
        } catch (error) {
          console.warn('Failed to stop test crawl:', error);
        }
      }
    });

    it('should handle invalid URL', async () => {
      await expect(
        knowledgeService.crawlUrl({
          url: 'not-a-valid-url',
          knowledge_type: 'technical',
        })
      ).rejects.toThrow();
    });
  });

  describe('Document Operations', () => {
    it('should get chunks for a knowledge item if it exists', async () => {
      // First get any existing item
      const items = await knowledgeService.getKnowledgeSummaries({ per_page: 1 });
      
      if (items.items.length > 0) {
        const sourceId = items.items[0].source_id;
        const chunks = await knowledgeService.getKnowledgeItemChunks(sourceId);
        
        expect(chunks).toHaveProperty('success');
        expect(chunks).toHaveProperty('source_id');
        expect(chunks).toHaveProperty('chunks');
        expect(chunks).toHaveProperty('total');
        expect(Array.isArray(chunks.chunks)).toBe(true);
        expect(chunks.source_id).toBe(sourceId);
      }
    });

    it('should get code examples for a knowledge item if it exists', async () => {
      // First get any existing item
      const items = await knowledgeService.getKnowledgeSummaries({ per_page: 1 });
      
      if (items.items.length > 0) {
        const sourceId = items.items[0].source_id;
        const examples = await knowledgeService.getCodeExamples(sourceId);
        
        expect(examples).toHaveProperty('success');
        expect(examples).toHaveProperty('source_id');
        expect(examples).toHaveProperty('code_examples');
        expect(examples).toHaveProperty('total');
        expect(Array.isArray(examples.code_examples)).toBe(true);
        expect(examples.source_id).toBe(sourceId);
      }
    });
  });

  describe('Delete Operations', () => {
    it('should handle deletion of non-existent item', async () => {
      // Backend returns success for idempotent delete operations
      const result = await knowledgeService.deleteKnowledgeItem('non-existent-source-id');
      expect(result).toHaveProperty('success');
      expect(result.success).toBe(true);
    });
  });

  describe('Search Operations', () => {
    it('should search knowledge base', async () => {
      const results = await knowledgeService.searchKnowledgeBase({
        query: 'test',
        limit: 5,
      });

      expect(results).toBeDefined();
      // Results structure depends on backend implementation
    });
  });

  describe('Sources', () => {
    it('should get knowledge sources', async () => {
      const sources = await knowledgeService.getKnowledgeSources();
      
      expect(Array.isArray(sources)).toBe(true);
      // Sources might be empty array if no sources exist
    });
  });
});