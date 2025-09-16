/**
 * Integration tests for Progress API
 * Tests progress polling with actual backend
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { progressService } from '../../../src/features/knowledge/progress/services';
import { knowledgeService } from '../../../src/features/knowledge/services';
import type { ProgressResponse } from '../../../src/features/knowledge/progress/types';

// Skip in CI, only run locally with backend
const skipInCI = process.env.CI ? describe.skip : describe;

// Helper to wait for a condition
const waitFor = async (
  condition: () => Promise<boolean>,
  timeout = 10000,
  interval = 100
): Promise<void> => {
  const startTime = Date.now();
  
  while (Date.now() - startTime < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  
  throw new Error('Timeout waiting for condition');
};

skipInCI('Progress API Integration', () => {
  let testProgressId: string | null = null;

  beforeAll(() => {
    // Ensure we're testing against local backend
    if (!import.meta.env.DEV) {
      throw new Error('Integration tests should only run in development mode');
    }
  });

  afterAll(async () => {
    // Clean up test progress if exists
    if (testProgressId) {
      try {
        await knowledgeService.stopCrawl(testProgressId);
      } catch (error) {
        // Progress might already be completed
      }
    }
  });

  describe('Progress Tracking', () => {
    it('should track crawl progress', async () => {
      // Start a test crawl
      const crawlResponse = await knowledgeService.crawlUrl({
        url: 'https://example.com/integration-test',
        knowledge_type: 'technical',
        max_depth: 1,
      });

      expect(crawlResponse.progressId).toBeDefined();
      testProgressId = crawlResponse.progressId;

      // Poll for progress
      const progress = await progressService.getProgress(testProgressId);
      
      expect(progress).toHaveProperty('progressId');
      expect(progress).toHaveProperty('status');
      expect(progress).toHaveProperty('progress');
      expect(progress.progressId).toBe(testProgressId);
      // Type field might not be included in all progress responses
      if (progress.type) {
        expect(progress.type).toBe('crawl');
      }
      
      // Stop the crawl to clean up
      await knowledgeService.stopCrawl(testProgressId);
    });

    it('should return 404 for non-existent progress', async () => {
      await expect(
        progressService.getProgress('non-existent-progress-id')
      ).rejects.toThrow();
    });

    it('should handle progress state transitions', async () => {
      // Start a small crawl
      const crawlResponse = await knowledgeService.crawlUrl({
        url: 'https://httpbin.org/html', // Simple test page
        knowledge_type: 'technical',
        max_depth: 1,
      });

      const progressId = crawlResponse.progressId;
      
      // Track state changes
      const states = new Set<string>();
      let lastProgress = 0;
      
      // Poll for a few seconds to see state changes
      for (let i = 0; i < 10; i++) {
        try {
          const progress = await progressService.getProgress(progressId);
          states.add(progress.status);
          
          // Progress should never go backwards
          expect(progress.progress).toBeGreaterThanOrEqual(lastProgress);
          lastProgress = progress.progress;
          
          // Check for terminal states
          if (['completed', 'error', 'failed', 'cancelled'].includes(progress.status)) {
            break;
          }
        } catch (error) {
          // Progress might be cleaned up after completion
          break;
        }
        
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
      // Should have seen at least one state
      expect(states.size).toBeGreaterThan(0);
      
      // Clean up
      try {
        await knowledgeService.stopCrawl(progressId);
      } catch {
        // Might already be completed
      }
    });

    it.skip('should track upload progress', async () => {
      // Skip: FormData file uploads don't work properly in Node/jsdom test environment
      // The backend expects multipart/form-data which needs real browser environment
      const file = new File(['test content for integration'], 'test-integration.txt', {
        type: 'text/plain',
      });
      
      const uploadResponse = await knowledgeService.uploadDocument(file, {
        knowledge_type: 'technical',
        tags: ['integration-test'],
      });
      
      expect(uploadResponse.progressId).toBeDefined();
      const progressId = uploadResponse.progressId;
      
      // Poll for progress
      const progress = await progressService.getProgress(progressId);
      
      expect(progress).toHaveProperty('progressId');
      expect(progress).toHaveProperty('status');
      expect(progress).toHaveProperty('progress');
      expect(progress.type).toBe('upload');
      expect(progress.fileName).toBe('test-integration.txt');
      
      // Wait for completion (uploads are usually fast)
      await waitFor(
        async () => {
          try {
            const p = await progressService.getProgress(progressId);
            return p.status === 'completed';
          } catch {
            return true; // Progress might be cleaned up
          }
        },
        5000
      );
    });
  });

  describe('Active Operations', () => {
    it('should list active operations', async () => {
      // This might return empty array if no operations are active
      const response = await progressService.listActiveOperations();
      
      expect(response).toHaveProperty('operations');
      expect(response).toHaveProperty('count');
      expect(response).toHaveProperty('timestamp');
      expect(Array.isArray(response.operations)).toBe(true);
      expect(typeof response.count).toBe('number');
      
      // If there are operations, check their structure
      if (response.operations.length > 0) {
        const op = response.operations[0];
        expect(op).toHaveProperty('operation_id');
        expect(op).toHaveProperty('operation_type');
        expect(op).toHaveProperty('status');
        expect(op).toHaveProperty('progress');
      }
    });
  });

  describe('Progress Cleanup', () => {
    it.skip('should clean up completed progress after time', async () => {
      // Skip: Requires file upload which doesn't work in test environment
      // Start a small upload that completes quickly
      const file = new File(['small'], 'small.txt', { type: 'text/plain' });
      const uploadResponse = await knowledgeService.uploadDocument(file, {
        knowledge_type: 'technical',
      });
      
      const progressId = uploadResponse.progressId;
      
      // Wait for completion
      await waitFor(
        async () => {
          try {
            const p = await progressService.getProgress(progressId);
            return p.status === 'completed';
          } catch {
            return false;
          }
        },
        10000
      );
      
      // Progress should be available immediately after completion
      const progress = await progressService.getProgress(progressId);
      expect(progress.status).toBe('completed');
      
      // Note: Backend might keep completed progress for a while
      // so we can't reliably test auto-cleanup in integration tests
    });
  });
});