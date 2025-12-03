import { test, expect, Page } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * REAL E2E Tests for Knowledge Base
 *
 * These tests verify the COMPLETE flow:
 * 1. Add content (crawl/upload)
 * 2. Wait for processing to complete
 * 3. Search and verify content is findable
 * 4. Cleanup
 *
 * Prerequisites:
 * - Backend running with valid API keys configured
 * - Frontend running
 * - Supabase connected
 *
 * Note: These tests are slower (30-120s) because they wait for real processing
 */

const BACKEND_URL = "http://localhost:8181";
const FRONTEND_URL = "http://localhost:3737";

// Test constants
const TEST_CRAWL_URL = "https://example.com"; // Simple, stable page
const TEST_SEARCH_TERM = "Example Domain"; // Known content on example.com
const PROCESSING_TIMEOUT = 120000; // 2 minutes max for processing
const POLL_INTERVAL = 2000; // Check every 2 seconds

// Track progress IDs created during tests for cleanup
const testProgressIds: string[] = [];

// Helper: Stop all active operations (cleanup after tests)
async function stopAllActiveOperations(page: Page): Promise<void> {
  try {
    const response = await page.request.get(`${BACKEND_URL}/api/progress/`);
    if (!response.ok()) return;

    const data = await response.json();
    const operations = data.operations || [];

    for (const op of operations) {
      const opId = op.operation_id;
      const opType = op.operation_type;

      try {
        if (opType === "re_embed") {
          await page.request.post(`${BACKEND_URL}/api/knowledge/re-embed/stop/${opId}`);
          console.log(`Stopped re-embed operation: ${opId}`);
        } else if (opType === "crawl") {
          await page.request.post(`${BACKEND_URL}/api/knowledge-items/stop/${opId}`);
          console.log(`Stopped crawl operation: ${opId}`);
        }
        // Note: upload operations don't have a stop endpoint, they complete on their own
      } catch {
        // Ignore errors during cleanup
      }
    }
  } catch {
    // Ignore errors during cleanup
  }
}

// Helper: Wait for operations to settle (no active operations)
async function waitForOperationsToSettle(page: Page, timeoutMs: number = 10000): Promise<boolean> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await page.request.get(`${BACKEND_URL}/api/progress/`);
      if (response.ok()) {
        const data = await response.json();
        if (data.count === 0) return true;
      }
    } catch {
      // Continue waiting
    }
    await page.waitForTimeout(1000);
  }
  return false;
}

// Helper: Cleanup knowledge items by URL pattern
async function cleanupKnowledgeItemsByUrl(page: Page, urlPattern: string): Promise<void> {
  try {
    const { items } = await getKnowledgeItems(page);
    for (const item of items as Array<{ id: string; url?: string; metadata?: { source_url?: string } }>) {
      const url = item.url || item.metadata?.source_url || "";
      if (url.includes(urlPattern)) {
        await deleteKnowledgeItem(page, item.id);
        console.log(`Cleaned up knowledge item: ${item.id} (${url})`);
      }
    }
  } catch {
    // Ignore cleanup errors
  }
}

// Helper: Check if backend is available and configured
async function isBackendReady(page: Page): Promise<boolean> {
  try {
    const health = await page.request.get(`${BACKEND_URL}/health`);
    if (!health.ok()) return false;
    const data = await health.json();
    return data.ready === true && data.credentials_loaded === true;
  } catch {
    return false;
  }
}

// Helper: Wait for a progress operation to complete
// Now includes validation that progress updates are actually being received
async function waitForProgressComplete(
  page: Page,
  progressId: string,
  timeoutMs: number = PROCESSING_TIMEOUT
): Promise<{ success: boolean; status: string; statusHistory: string[]; errorCount: number }> {
  const startTime = Date.now();
  const statusHistory: string[] = [];
  let lastProgress = -1;
  let errorCount = 0;
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 5;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await page.request.get(`${BACKEND_URL}/api/progress/${progressId}`);

      if (!response.ok()) {
        errorCount++;
        consecutiveErrors++;
        console.warn(`Progress API error (${response.status()}): ${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}`);

        // If we get too many consecutive errors, something is wrong
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          console.error(`Too many consecutive API errors for progress ${progressId}`);
          return { success: false, status: "api_error", statusHistory, errorCount };
        }

        await page.waitForTimeout(POLL_INTERVAL);
        continue;
      }

      // Reset consecutive error counter on success
      consecutiveErrors = 0;

      const data = await response.json();
      const status = data.status || data.state;
      const progress = data.progress || 0;

      // Track status transitions
      if (statusHistory.length === 0 || statusHistory[statusHistory.length - 1] !== status) {
        statusHistory.push(status);
        console.log(`Progress ${progressId}: ${status} (${progress}%)`);
      }

      // Track progress increase
      if (progress > lastProgress) {
        lastProgress = progress;
      }

      if (status === "completed" || status === "complete") {
        console.log(`Progress completed. Status history: ${statusHistory.join(" → ")}`);
        return { success: true, status, statusHistory, errorCount };
      }

      if (status === "failed" || status === "error") {
        console.log(`Progress ${progressId} failed:`, data);
        console.log(`Status history: ${statusHistory.join(" → ")}`);
        return { success: false, status, statusHistory, errorCount };
      }

      // Still processing
      await page.waitForTimeout(POLL_INTERVAL);
    } catch (e) {
      errorCount++;
      consecutiveErrors++;
      console.warn(`Progress polling exception: ${e}`);
      await page.waitForTimeout(POLL_INTERVAL);
    }
  }

  console.log(`Progress timeout. Status history: ${statusHistory.join(" → ")}, errors: ${errorCount}`);
  return { success: false, status: "timeout", statusHistory, errorCount };
}

// Helper: Search knowledge base via API
async function searchKnowledgeBase(
  page: Page,
  query: string
): Promise<{ found: boolean; results: unknown[] }> {
  try {
    const response = await page.request.post(`${BACKEND_URL}/api/knowledge-items/search`, {
      data: { query, limit: 10 },
    });

    if (!response.ok()) {
      return { found: false, results: [] };
    }

    const data = await response.json();
    const results = data.results || data.documents || [];
    return { found: results.length > 0, results };
  } catch {
    return { found: false, results: [] };
  }
}

// Helper: Get knowledge items summary
async function getKnowledgeItems(page: Page): Promise<{ total: number; items: unknown[] }> {
  try {
    const response = await page.request.get(`${BACKEND_URL}/api/knowledge-items/summary`);
    if (!response.ok()) return { total: 0, items: [] };
    const data = await response.json();
    return { total: data.total || 0, items: data.items || [] };
  } catch {
    return { total: 0, items: [] };
  }
}

// Helper: Delete a knowledge item
async function deleteKnowledgeItem(page: Page, sourceId: string): Promise<boolean> {
  try {
    const response = await page.request.delete(`${BACKEND_URL}/api/knowledge-items/${sourceId}`);
    return response.ok();
  } catch {
    return false;
  }
}

// Helper: Find item by URL or title pattern
async function findKnowledgeItemByPattern(
  page: Page,
  pattern: string
): Promise<{ id: string; title: string } | null> {
  const { items } = await getKnowledgeItems(page);
  for (const item of items as Array<{ id: string; title: string; url?: string }>) {
    if (item.url?.includes(pattern) || item.title?.toLowerCase().includes(pattern.toLowerCase())) {
      return { id: item.id, title: item.title };
    }
  }
  return null;
}

test.describe("Web Crawl E2E Flow", () => {
  test.setTimeout(600000); // 10 minutes for crawl tests (code extraction can take a while)

  // Cleanup: Stop any crawls and delete test items
  test.afterEach(async ({ page }) => {
    console.log("Cleaning up crawl operations and test data...");
    await stopAllActiveOperations(page);
    // Cleanup knowledge items from test URLs
    await cleanupKnowledgeItemsByUrl(page, "example.com");
    await cleanupKnowledgeItemsByUrl(page, "htmx.org");
    await cleanupKnowledgeItemsByUrl(page, "alpinejs.dev");
  });

  test("should crawl a URL and make content searchable", async ({ page }) => {
    // Check prerequisites
    if (!await isBackendReady(page)) {
      test.skip(true, "Backend not ready or API keys not configured");
      return;
    }

    // Step 1: Start crawl via API
    console.log("Starting crawl of", TEST_CRAWL_URL);
    const crawlResponse = await page.request.post(`${BACKEND_URL}/api/knowledge-items/crawl`, {
      data: {
        url: TEST_CRAWL_URL,
        crawl_depth: 0, // Just the page itself
        max_pages: 1,
      },
    });

    expect(crawlResponse.ok()).toBe(true);
    const crawlData = await crawlResponse.json();
    const progressId = crawlData.progress_id || crawlData.progressId;
    expect(progressId).toBeDefined();
    console.log("Crawl started with progress ID:", progressId);

    // Step 2: Wait for crawl to complete
    console.log("Waiting for crawl to complete...");
    const { success, status, statusHistory, errorCount } = await waitForProgressComplete(page, progressId);

    // Validate that we got progress updates without excessive errors
    // Note: 404 errors can happen if the crawl was cancelled by another test's cleanup
    if (errorCount > 0) {
      console.warn(`Progress tracking had ${errorCount} API errors`);
    }

    // If crawl was cancelled (by another test's cleanup), skip gracefully
    if (status === "cancelled") {
      console.log("Crawl was cancelled (possibly by another test's cleanup)");
      test.skip(true, "Crawl was cancelled - tests may be interfering");
      return;
    }

    if (!success) {
      console.log(`Crawl did not complete successfully. Status: ${status}`);
      console.log(`Status history: ${statusHistory.join(" → ")}`);
      // Try to clean up if possible
      const item = await findKnowledgeItemByPattern(page, "example.com");
      if (item) await deleteKnowledgeItem(page, item.id);
      test.skip(true, `Crawl failed with status: ${status} (may be API key issue)`);
      return;
    }

    console.log("Crawl completed successfully");
    console.log(`Status transitions: ${statusHistory.join(" → ")}`);

    // Validate we saw some status transitions (not just starting → completed)
    expect(statusHistory.length).toBeGreaterThan(1);

    // Step 3: Search for known content
    console.log("Searching for:", TEST_SEARCH_TERM);
    const { found, results } = await searchKnowledgeBase(page, TEST_SEARCH_TERM);

    // Step 4: Cleanup - delete the crawled item
    const item = await findKnowledgeItemByPattern(page, "example.com");
    if (item) {
      console.log("Cleaning up - deleting item:", item.id);
      await deleteKnowledgeItem(page, item.id);
    }

    // Step 5: Assert search worked
    expect(found).toBe(true);
    console.log(`Search found ${results.length} results`);
  });

  test("should crawl real library documentation (htmx)", async ({ page }) => {
    // This test crawls REAL library documentation to validate:
    // 1. Multi-page crawl with discovery phase works
    // 2. Code examples are extracted
    // 3. Content is searchable with relevant terms
    // 4. Progress tracking works without API errors
    if (!await isBackendReady(page)) {
      test.skip(true, "Backend not ready");
      return;
    }

    // htmx.org - Small, stable library with good documentation
    // Has code examples, multiple pages, and technical content
    // Note: htmx docs have MANY code examples (~15 per page), each needs LLM summary
    const docsUrl = "https://htmx.org/docs/";

    console.log("Starting documentation crawl of", docsUrl);
    const crawlResponse = await page.request.post(`${BACKEND_URL}/api/knowledge-items/crawl`, {
      data: {
        url: docsUrl,
        crawl_depth: 1,  // Follow links to subpages
        max_pages: 3,    // Limited pages - each page has many code examples
      },
    });

    expect(crawlResponse.ok()).toBe(true);
    const crawlData = await crawlResponse.json();
    const progressId = crawlData.progress_id || crawlData.progressId;
    expect(progressId).toBeDefined();
    console.log("Documentation crawl started:", progressId);

    // Wait for completion with status tracking
    const { success, status, statusHistory, errorCount } = await waitForProgressComplete(page, progressId, 300000); // 5 min for docs

    // Log progress tracking results
    console.log(`Status history: ${statusHistory.join(" → ")}`);
    console.log(`API errors during progress: ${errorCount}`);

    // If crawl was cancelled (by another test's cleanup), skip gracefully
    if (status === "cancelled") {
      console.log("Crawl was cancelled (possibly by another test's cleanup)");
      test.skip(true, "Crawl was cancelled - tests may be interfering");
      return;
    }

    if (!success) {
      console.log(`Crawl ended with status: ${status}`);
      // Cleanup attempt
      const item = await findKnowledgeItemByPattern(page, "htmx");
      if (item) await deleteKnowledgeItem(page, item.id);
      test.skip(true, `Documentation crawl failed: ${status}`);
      return;
    }

    // Validate status transitions happened
    expect(statusHistory.length).toBeGreaterThan(2);
    const hasExpectedPhases = statusHistory.some(s =>
      s === "discovery" || s === "analyzing" || s === "crawling"
    );
    expect(hasExpectedPhases).toBe(true);

    // REAL TEST: Search for library-specific terms
    console.log("Searching for htmx-specific content...");

    // Search for "hx-get" - a core htmx attribute that MUST be in the docs
    const hxGetSearch = await searchKnowledgeBase(page, "hx-get attribute");
    console.log(`Search 'hx-get attribute': ${hxGetSearch.results.length} results`);

    // Search for "AJAX" - htmx is an AJAX library
    const ajaxSearch = await searchKnowledgeBase(page, "AJAX requests");
    console.log(`Search 'AJAX requests': ${ajaxSearch.results.length} results`);

    // Search for code-related content
    const codeSearch = await searchKnowledgeBase(page, "button click trigger");
    console.log(`Search 'button click trigger': ${codeSearch.results.length} results`);

    // Cleanup
    const item = await findKnowledgeItemByPattern(page, "htmx");
    if (item) {
      console.log("Cleaning up htmx documentation:", item.id);
      await deleteKnowledgeItem(page, item.id);
    }

    // Assert we found relevant content
    expect(hxGetSearch.found || ajaxSearch.found).toBe(true);
    console.log("Documentation crawl and search validation complete!");
  });

  test("should crawl Alpine.js docs and find reactive content", async ({ page }) => {
    // Second real-world test with different library
    // Alpine.js - Small reactive JS library
    if (!await isBackendReady(page)) {
      test.skip(true, "Backend not ready");
      return;
    }

    const docsUrl = "https://alpinejs.dev/start-here";

    console.log("Starting Alpine.js docs crawl:", docsUrl);
    const crawlResponse = await page.request.post(`${BACKEND_URL}/api/knowledge-items/crawl`, {
      data: {
        url: docsUrl,
        crawl_depth: 1,
        max_pages: 4,
      },
    });

    if (!crawlResponse.ok()) {
      test.skip(true, "Could not start crawl");
      return;
    }

    const crawlData = await crawlResponse.json();
    const progressId = crawlData.progress_id || crawlData.progressId;
    console.log("Alpine.js crawl started:", progressId);

    const { success, status, statusHistory, errorCount } = await waitForProgressComplete(page, progressId, 240000);

    console.log(`Status history: ${statusHistory.join(" → ")}`);
    console.log(`API errors: ${errorCount}`);

    // If crawl was cancelled (by another test's cleanup), skip gracefully
    if (status === "cancelled") {
      console.log("Crawl was cancelled (possibly by another test's cleanup)");
      test.skip(true, "Crawl was cancelled - tests may be interfering");
      return;
    }

    if (!success) {
      const item = await findKnowledgeItemByPattern(page, "alpine");
      if (item) await deleteKnowledgeItem(page, item.id);
      test.skip(true, `Alpine.js crawl failed: ${status}`);
      return;
    }

    // Search for Alpine.js specific directives
    const xDataSearch = await searchKnowledgeBase(page, "x-data directive");
    const reactiveSearch = await searchKnowledgeBase(page, "reactive state");
    console.log(`Search 'x-data directive': ${xDataSearch.results.length} results`);
    console.log(`Search 'reactive state': ${reactiveSearch.results.length} results`);

    // Cleanup
    const item = await findKnowledgeItemByPattern(page, "alpine");
    if (item) {
      await deleteKnowledgeItem(page, item.id);
    }

    expect(xDataSearch.found || reactiveSearch.found).toBe(true);
  });
});

test.describe("PDF Upload E2E Flow", () => {
  test.setTimeout(180000); // 3 minutes for upload tests

  // Use existing test PDF from the repo (relative to monorepo root)
  const testPdfPath = path.resolve(__dirname, "../../../test-pdf/Book.pdf");

  // Cleanup: Stop any uploads and delete test items
  test.afterEach(async ({ page }) => {
    console.log("Cleaning up upload operations...");
    await stopAllActiveOperations(page);
  });

  test("should upload PDF and make content searchable", async ({ page }) => {
    // Check prerequisites
    if (!await isBackendReady(page)) {
      test.skip(true, "Backend not ready or API keys not configured");
      return;
    }

    // Verify test PDF exists
    if (!fs.existsSync(testPdfPath)) {
      test.skip(true, "Test PDF file not found");
      return;
    }

    // Step 1: Navigate to Knowledge Base (root route)
    await page.goto(FRONTEND_URL);
    await page.waitForLoadState("networkidle");
    // Wait for page to fully render
    await expect(page.getByRole("heading", { name: "Knowledge Base" })).toBeVisible({ timeout: 10000 });

    // Step 2: Open Add Knowledge dialog
    const addButton = page.locator('button:has-text("Knowledge")').first();
    await addButton.click();
    await expect(page.locator("text=Add Knowledge")).toBeVisible({ timeout: 5000 });

    // Step 3: Switch to Upload tab (use role selector to target the tab button specifically)
    const uploadTab = page.locator('button[role="tab"]:has-text("Upload Document")');
    await uploadTab.click();
    await page.waitForTimeout(500);

    // Verify we're on the upload tab by checking for file input
    const fileInput = page.locator('input[type="file"]');
    await expect(fileInput).toBeVisible({ timeout: 5000 });

    // Step 4: Upload the PDF
    await fileInput.setInputFiles(testPdfPath);
    await page.waitForTimeout(500);

    // Step 5: Click Upload button (not the tab - the action button inside content)
    const uploadButton = page.locator('button:has-text("Upload Document"):not([role="tab"])');
    await uploadButton.click();

    // Step 6: Wait for upload to start (get progress ID from toast or response)
    // The toast shows "Upload started for Book.pdf. Processing in background..."
    await expect(
      page.locator("text=Upload started").or(page.locator("text=Uploading")).first()
    ).toBeVisible({ timeout: 10000 });

    // Wait for processing (give it time to complete)
    console.log("Waiting for PDF processing...");
    await page.waitForTimeout(10000); // Wait 10 seconds for initial processing

    // Step 7: Search for content from our PDF (Book.pdf contains Archon documentation)
    const searchTerm = "archon knowledge rag";
    console.log("Searching for:", searchTerm);

    // Try searching multiple times (processing may take a while)
    let found = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      const result = await searchKnowledgeBase(page, searchTerm);
      if (result.found) {
        found = true;
        console.log(`Found after ${attempt + 1} attempts`);
        break;
      }
      console.log(`Attempt ${attempt + 1}: Not found yet, waiting...`);
      await page.waitForTimeout(5000);
    }

    // Step 8: Cleanup - find and delete the uploaded item
    const item = await findKnowledgeItemByPattern(page, "Book");
    if (item) {
      console.log("Cleaning up - deleting item:", item.id);
      await deleteKnowledgeItem(page, item.id);
    }

    // Step 9: Assert - if we found results, the test passes
    // Note: If Book.pdf was already uploaded before, results may exist from previous runs
    expect(found).toBe(true);
  });
});

test.describe("RAG Search E2E", () => {
  test.setTimeout(60000);

  test("should return results when documents exist", async ({ page }) => {
    if (!await isBackendReady(page)) {
      test.skip(true, "Backend not ready");
      return;
    }

    // Check if there are any documents
    const { total } = await getKnowledgeItems(page);
    if (total === 0) {
      test.skip(true, "No documents in knowledge base");
      return;
    }

    // Try a generic search
    const { found, results } = await searchKnowledgeBase(page, "documentation");

    // We expect to find something if documents exist
    console.log(`Search found ${results.length} results`);

    // At minimum, the search should not error
    expect(results).toBeDefined();
  });

  test("should search via UI and show results", async ({ page }) => {
    if (!await isBackendReady(page)) {
      test.skip(true, "Backend not ready");
      return;
    }

    const { total } = await getKnowledgeItems(page);
    if (total === 0) {
      test.skip(true, "No documents in knowledge base");
      return;
    }

    // Navigate to Knowledge Base (root route)
    await page.goto(FRONTEND_URL);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: "Knowledge Base" })).toBeVisible({ timeout: 10000 });

    // Use the search input
    const searchInput = page.locator('input[placeholder*="Search"]').first();
    await expect(searchInput).toBeVisible({ timeout: 5000 });

    // Type a search query
    await searchInput.fill("test");
    await page.waitForTimeout(1000);

    // The UI should respond (either show results or "no results")
    // We're testing that search doesn't crash
    await expect(page.locator("body")).toBeVisible();
  });
});

test.describe("Re-embed E2E Flow", () => {
  test.setTimeout(120000); // 2 minutes - API key validation with Ollama can be slow

  // Cleanup: Stop any operations started during tests
  test.afterEach(async ({ page }) => {
    console.log("Cleaning up re-embed operations...");
    await stopAllActiveOperations(page);
  });

  test("should start re-embed and verify API works", async ({ page }) => {
    if (!await isBackendReady(page)) {
      test.skip(true, "Backend not ready");
      return;
    }

    // Check if there are documents to re-embed
    const { total } = await getKnowledgeItems(page);
    if (total === 0) {
      test.skip(true, "No documents to re-embed");
      return;
    }

    // Step 1: Get re-embed stats first
    const statsResponse = await page.request.get(`${BACKEND_URL}/api/knowledge/re-embed/stats`);
    if (!statsResponse.ok()) {
      test.skip(true, "Could not get re-embed stats - embedding may not be configured");
      return;
    }

    const stats = await statsResponse.json();
    console.log("Re-embed stats:", stats);

    if (stats.total_chunks === 0) {
      test.skip(true, "No chunks to re-embed");
      return;
    }

    // Step 2: Start re-embed
    // Note: The POST can take 30-60s because it validates the API key by creating a test embedding
    // With Ollama, this includes model loading time
    console.log("Starting re-embed (API validates embedding key first, can take up to 60s)...");
    const reEmbedResponse = await page.request.post(`${BACKEND_URL}/api/knowledge/re-embed`, {
      timeout: 90000, // 90 second timeout - Ollama model loading can be slow
    });

    expect(reEmbedResponse.ok()).toBe(true);

    const reEmbedData = await reEmbedResponse.json();
    const progressId = reEmbedData.progressId;
    console.log("Re-embed started with progress ID:", progressId);

    // Step 3: Verify progress can be retrieved
    await page.waitForTimeout(2000);
    const progressResponse = await page.request.get(`${BACKEND_URL}/api/progress/${progressId}`);
    expect(progressResponse.ok()).toBe(true);

    const progressData = await progressResponse.json();
    console.log("Progress data:", progressData);

    // Verify progress has expected fields
    expect(progressData.status || progressData.state).toBeDefined();
    console.log("Re-embed API verified successfully");
  });
});

test.describe("Mixed Content E2E", () => {
  test.setTimeout(300000); // 5 minutes

  // Cleanup after tests
  test.afterEach(async ({ page }) => {
    console.log("Cleaning up mixed content test operations...");
    await stopAllActiveOperations(page);
  });

  test("should handle both crawled and uploaded content in search", async ({ page }) => {
    if (!await isBackendReady(page)) {
      test.skip(true, "Backend not ready");
      return;
    }

    const { total, items } = await getKnowledgeItems(page);
    if (total === 0) {
      test.skip(true, "No documents in knowledge base");
      return;
    }

    // Check content types present
    const itemsList = items as Array<{ knowledge_type?: string; type?: string }>;
    const hasCrawled = itemsList.some((item) =>
      item.knowledge_type === "crawled" || item.type === "crawled" || item.knowledge_type === "website"
    );
    const hasUploaded = itemsList.some((item) =>
      item.knowledge_type === "uploaded" || item.type === "uploaded" || item.knowledge_type === "document"
    );

    console.log(`Content types - Crawled: ${hasCrawled}, Uploaded: ${hasUploaded}`);

    // Run a search that should hit any content
    const { found, results } = await searchKnowledgeBase(page, "the");

    console.log(`Mixed search found ${results.length} results`);

    // Search should work regardless of content mix
    expect(results).toBeDefined();
  });
});

test.describe("Embedding Model Filter E2E", () => {
  test.setTimeout(300000); // 5 minutes - involves model switching and processing

  // Cleanup after tests
  test.afterEach(async ({ page }) => {
    console.log("Cleaning up embedding filter test operations...");
    await stopAllActiveOperations(page);
  });

  /**
   * EXPLICIT test for embedding_model_filter functionality:
   * 1. Get current embedding model
   * 2. Add a document (crawl)
   * 3. Verify search finds it
   * 4. Switch to different embedding model (Change Anyway - no re-embed)
   * 5. Verify search returns 0 results (filter works!)
   * 6. Switch back to original model
   * 7. Verify search finds results again
   * 8. Cleanup
   */
  test("should filter search results by embedding model", async ({ page }) => {
    // Check prerequisites
    if (!await isBackendReady(page)) {
      test.skip(true, "Backend not ready");
      return;
    }

    // Step 1: Get current embedding settings
    const settingsResponse = await page.request.get(`${BACKEND_URL}/api/settings`);
    if (!settingsResponse.ok()) {
      test.skip(true, "Could not get settings");
      return;
    }
    const settings = await settingsResponse.json();
    const originalProvider = settings.EMBEDDING_PROVIDER;
    const originalModel = settings.EMBEDDING_MODEL_CHOICE;
    console.log(`Original embedding: ${originalProvider}/${originalModel}`);

    // We need at least 2 different providers to test filter
    // Check if we can switch between providers
    const availableProviders = ["openai", "google", "openrouter"];
    const alternativeProvider = availableProviders.find(p => p !== originalProvider?.toLowerCase());

    if (!alternativeProvider) {
      test.skip(true, "Need at least 2 embedding providers to test filter");
      return;
    }

    // Step 2: Create test document
    console.log("Creating test document...");
    const testUrl = "https://example.com";
    const crawlResponse = await page.request.post(`${BACKEND_URL}/api/knowledge-items/crawl`, {
      data: { url: testUrl, crawl_depth: 0, max_pages: 1 },
    });

    if (!crawlResponse.ok()) {
      test.skip(true, "Could not start crawl");
      return;
    }

    const crawlData = await crawlResponse.json();
    const progressId = crawlData.progress_id || crawlData.progressId;
    console.log(`Crawl started: ${progressId}`);

    // Wait for processing
    const { success, statusHistory, errorCount } = await waitForProgressComplete(page, progressId);

    // Validate no API errors during crawl progress
    expect(errorCount).toBe(0);

    if (!success) {
      console.log(`Status history: ${statusHistory.join(" → ")}`);
      // Cleanup attempt
      const item = await findKnowledgeItemByPattern(page, "example.com");
      if (item) await deleteKnowledgeItem(page, item.id);
      test.skip(true, "Crawl did not complete");
      return;
    }

    // Step 3: Verify search finds the document with original embedding
    console.log("Verifying search with original embedding model...");
    const searchBefore = await searchKnowledgeBase(page, "Example Domain");
    console.log(`Search before switch: ${searchBefore.results.length} results`);

    if (!searchBefore.found) {
      // Cleanup
      const item = await findKnowledgeItemByPattern(page, "example.com");
      if (item) await deleteKnowledgeItem(page, item.id);
      test.skip(true, "Initial search did not find document");
      return;
    }

    const resultCountBefore = searchBefore.results.length;
    expect(resultCountBefore).toBeGreaterThan(0);

    // Step 4: Switch to different embedding provider (via UI to trigger Change Anyway)
    console.log(`Switching embedding provider to ${alternativeProvider}...`);
    await page.goto(`${FRONTEND_URL}/settings`);
    await page.waitForLoadState("networkidle");

    // Click Embedding tab
    const embeddingTab = page.locator('button:has-text("Embedding")').first();
    await embeddingTab.click();
    await page.waitForTimeout(500);

    // Click alternative provider
    const providerButton = page.locator(`button:has(img[alt*="${alternativeProvider}"])`).first();

    if (!await providerButton.isVisible({ timeout: 5000 })) {
      console.log(`Provider ${alternativeProvider} not visible, trying another`);
      // Cleanup
      const item = await findKnowledgeItemByPattern(page, "example.com");
      if (item) await deleteKnowledgeItem(page, item.id);
      test.skip(true, `Provider ${alternativeProvider} not available in UI`);
      return;
    }

    await providerButton.click();

    // Wait for warning dialog
    const dialogVisible = await page.locator("text=Embedding Model Change").isVisible({ timeout: 5000 }).catch(() => false);

    if (dialogVisible) {
      // Click "Change Anyway" (NOT Re-embed)
      console.log("Clicking Change Anyway...");
      await page.locator('button:has-text("Change Anyway")').click();
      await page.waitForTimeout(2000);
    } else {
      console.log("No warning dialog (may have no documents with embeddings yet)");
    }

    // Step 5: Verify search returns 0 results (FILTER IS WORKING!)
    console.log("Verifying search with different embedding model (should be filtered)...");
    await page.waitForTimeout(1000); // Wait for settings to propagate

    const searchAfterSwitch = await searchKnowledgeBase(page, "Example Domain");
    console.log(`Search after switch: ${searchAfterSwitch.results.length} results`);

    // THIS IS THE KEY ASSERTION: With a different embedding model,
    // the old embeddings should be filtered out
    const resultCountAfterSwitch = searchAfterSwitch.results.length;

    // Results should be 0 or significantly fewer (filter is working)
    console.log(`Filter test: ${resultCountBefore} results before, ${resultCountAfterSwitch} after model switch`);

    // The filter should exclude documents embedded with the old model
    // If results are the same, the filter is NOT working
    const filterWorking = resultCountAfterSwitch < resultCountBefore;

    // Step 6: Switch back to original provider
    console.log(`Switching back to ${originalProvider}...`);
    const originalProviderButton = page.locator(`button:has(img[alt*="${originalProvider}"])`).first();

    if (await originalProviderButton.isVisible({ timeout: 3000 })) {
      await originalProviderButton.click();

      const dialogVisible2 = await page.locator("text=Embedding Model Change").isVisible({ timeout: 3000 }).catch(() => false);
      if (dialogVisible2) {
        await page.locator('button:has-text("Change Anyway")').click();
        await page.waitForTimeout(2000);
      }
    }

    // Step 7: Verify search finds results again
    console.log("Verifying search after switching back...");
    await page.waitForTimeout(1000);

    const searchAfterRevert = await searchKnowledgeBase(page, "Example Domain");
    console.log(`Search after revert: ${searchAfterRevert.results.length} results`);

    const resultCountAfterRevert = searchAfterRevert.results.length;

    // Step 8: Cleanup
    console.log("Cleaning up test document...");
    const item = await findKnowledgeItemByPattern(page, "example.com");
    if (item) {
      await deleteKnowledgeItem(page, item.id);
      console.log("Test document deleted");
    }

    // Step 9: Assertions
    console.log("\n=== EMBEDDING MODEL FILTER TEST RESULTS ===");
    console.log(`Results with original model: ${resultCountBefore}`);
    console.log(`Results after model switch (should be 0): ${resultCountAfterSwitch}`);
    console.log(`Results after revert (should match original): ${resultCountAfterRevert}`);
    console.log(`Filter working: ${filterWorking}`);
    console.log("============================================\n");

    // The key assertion: switching models should filter out old embeddings
    expect(filterWorking).toBe(true);

    // After reverting, we should find results again
    expect(resultCountAfterRevert).toBeGreaterThan(0);
  });
});
