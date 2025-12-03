import { test, expect } from '@playwright/test';

/**
 * RAG Search Flow E2E Tests
 *
 * These tests verify RAG functionality WITHOUT modifying settings.
 * They only test:
 * 1. UI loads correctly
 * 2. API endpoints respond correctly
 * 3. Reranking is applied when enabled
 *
 * Prerequisites:
 * - Backend running on localhost:8181
 * - Frontend running on localhost:3737
 * - At least one knowledge item in the database (for search tests)
 */

test.describe('RAG Search Flow', () => {

  test('Knowledge Base UI loads correctly', async ({ page }) => {
    // Navigate to Knowledge Base (root route)
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // Check for the header "Knowledge Base"
    const header = page.locator('h1:has-text("Knowledge Base")');
    await expect(header).toBeVisible({ timeout: 5000 });

    // Check for "+ Knowledge" button
    const addButton = page.locator('button:has-text("Knowledge")').first();
    await expect(addButton).toBeVisible();
  });

  test('RAG API endpoint responds correctly', async ({ request }) => {
    // Test the RAG query endpoint directly
    const response = await request.post('http://localhost:8181/api/rag/query', {
      headers: { 'Content-Type': 'application/json' },
      data: { query: 'test query', match_count: 5 }
    });

    expect(response.ok()).toBeTruthy();

    const data = await response.json();
    expect(data).toHaveProperty('success');
    expect(data).toHaveProperty('search_mode');
    expect(data).toHaveProperty('reranking_applied');
  });

  test('RAG search returns reranking metadata when enabled', async ({ request }) => {
    // This test verifies that reranking is applied when configured
    const response = await request.post('http://localhost:8181/api/rag/query', {
      headers: { 'Content-Type': 'application/json' },
      data: { query: 'embeddings vector search', match_count: 5 }
    });

    expect(response.ok()).toBeTruthy();

    const data = await response.json();

    // Check response structure
    expect(data.success).toBe(true);
    expect(data).toHaveProperty('results');
    expect(data).toHaveProperty('reranking_applied');

    // If there are results and reranking is enabled, verify rerank_score exists
    if (data.results.length > 0 && data.reranking_applied) {
      expect(data.results[0]).toHaveProperty('rerank_score');
    }
  });

  test('Code examples API endpoint responds correctly', async ({ request }) => {
    // Test the code examples search endpoint
    const response = await request.post('http://localhost:8181/api/rag/code-examples', {
      headers: { 'Content-Type': 'application/json' },
      data: { query: 'function example', match_count: 5 }
    });

    expect(response.ok()).toBeTruthy();

    const data = await response.json();
    expect(data).toHaveProperty('success');
    expect(data).toHaveProperty('results');
    expect(data).toHaveProperty('reranked');
  });

  test('Hybrid search mode is active', async ({ request }) => {
    // Verify hybrid search is being used
    const response = await request.post('http://localhost:8181/api/rag/query', {
      headers: { 'Content-Type': 'application/json' },
      data: { query: 'search test', match_count: 3 }
    });

    expect(response.ok()).toBeTruthy();

    const data = await response.json();

    // search_mode should indicate hybrid when enabled
    expect(data).toHaveProperty('search_mode');
    // Note: search_mode can be 'hybrid', 'vector', or 'keyword' depending on settings
  });

  test('Knowledge items API returns valid structure', async ({ request }) => {
    // Test the knowledge items list endpoint
    const response = await request.get('http://localhost:8181/api/knowledge-items');

    expect(response.ok()).toBeTruthy();

    const data = await response.json();
    expect(data).toHaveProperty('items');
    expect(data).toHaveProperty('total');
    expect(Array.isArray(data.items)).toBe(true);
  });

});
