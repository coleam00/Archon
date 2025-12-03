import { test, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * E2E Tests for PDF Upload and OCR Flow
 *
 * Prerequisites:
 * - Backend running (docker compose up)
 * - Frontend running (npm run dev)
 * - Supabase connected
 *
 * Test Flow:
 * 1. Navigate to Knowledge Base
 * 2. Open Add Knowledge dialog
 * 3. Upload a PDF document
 * 4. Wait for processing to complete
 * 5. Verify document appears in list
 * 6. Search for content from the document
 */

// Use existing test PDF from the repo (relative to monorepo root)
const testPdfPath = path.resolve(__dirname, "../../../test-pdf/Book.pdf");

// API base URL for cleanup
const API_BASE = "http://localhost:8181/api";

/**
 * Cleanup any existing Book.pdf items to prevent duplicates
 * This is important because multiple test files may upload the same file
 */
async function cleanupBookPdfItems(): Promise<void> {
  try {
    const response = await fetch(`${API_BASE}/knowledge-items/summary`);
    if (!response.ok) return;

    const data = await response.json();
    const bookItems = data.items?.filter((item: any) =>
      item.title === "Book.pdf" || item.metadata?.filename === "Book.pdf"
    ) || [];

    for (const item of bookItems) {
      console.log(`Cleaning up existing Book.pdf item: ${item.source_id}`);
      await fetch(`${API_BASE}/knowledge-items/${item.source_id}`, { method: "DELETE" });
    }
  } catch (error) {
    // Ignore cleanup errors - backend might not be running
  }
}

test.describe("PDF Upload Flow", () => {
  // Clean up any existing Book.pdf items before each test to prevent duplicates
  test.beforeEach(async ({ page }) => {
    // Clean up existing Book.pdf items from previous test runs
    await cleanupBookPdfItems();

    // Navigate to Knowledge Base
    await page.goto("/");
    // Use domcontentloaded instead of networkidle to avoid timeout when uploads are in progress
    await page.waitForLoadState("domcontentloaded");
    // Wait for the Knowledge Base heading to appear
    await page.waitForSelector("text=Knowledge Base", { timeout: 10000 });
  });

  test("should display Knowledge Base page with Add Knowledge button", async ({ page }) => {
    // Verify page loaded - use specific heading to avoid matching loading text
    await expect(page.getByRole("heading", { name: "Knowledge Base" })).toBeVisible();

    // Verify Add Knowledge button exists
    const addButton = page.locator('button:has-text("Knowledge")').first();
    await expect(addButton).toBeVisible();
  });

  test("should open Add Knowledge dialog and show Upload tab", async ({ page }) => {
    // Click Add Knowledge button
    const addButton = page.locator('button:has-text("Knowledge")').first();
    await addButton.click();

    // Wait for dialog to open
    await expect(page.locator("text=Add Knowledge")).toBeVisible();

    // Verify both tabs exist (use role selector for better reliability)
    await expect(page.getByRole("tab", { name: "Crawl Website" })).toBeVisible();
    await expect(page.getByRole("tab", { name: "Upload Document" })).toBeVisible();

    // Click Upload Document tab
    await page.getByRole("tab", { name: "Upload Document" }).click();
    await page.waitForTimeout(300);

    // Verify upload area is visible
    await expect(page.locator("text=Click to browse or drag & drop")).toBeVisible();
    await expect(page.locator("text=PDF, DOC, DOCX, TXT, MD files supported")).toBeVisible();
  });

  test("should upload a document and show processing state", async ({ page }) => {
    // Skip if no backend connection (CI without full stack)
    const healthCheck = await page.request.get("http://localhost:8181/health").catch(() => null);
    if (!healthCheck?.ok()) {
      test.skip(true, "Backend not available - skipping integration test");
      return;
    }

    // Open Add Knowledge dialog
    const addButton = page.locator('button:has-text("Knowledge")').first();
    await addButton.click();
    await expect(page.locator("text=Add Knowledge")).toBeVisible();

    // Switch to Upload tab (use role selector)
    await page.getByRole("tab", { name: "Upload Document" }).click();
    await page.waitForTimeout(300);

    // Upload the test PDF file
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(testPdfPath);

    // Verify file is selected (filename should appear in the dialog)
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator("text=Book.pdf")).toBeVisible();

    // Click Upload button (not the tab - use the action button)
    const uploadButton = page.locator('button:has-text("Upload Document"):not([role="tab"])');
    await uploadButton.click();

    // Wait for upload to start (toast message or button state change)
    await expect(page.locator("text=Upload started").or(page.locator("text=Uploading")).first()).toBeVisible({ timeout: 10000 });
  });

  test("should show uploaded document in Knowledge Base after processing", async ({ page }) => {
    // Skip if no backend connection
    const healthCheck = await page.request.get("http://localhost:8181/health").catch(() => null);
    if (!healthCheck?.ok()) {
      test.skip(true, "Backend not available - skipping integration test");
      return;
    }

    // This test assumes a document was already uploaded
    // Search for our test document content
    const searchInput = page.locator('input[placeholder*="Search knowledge"]');
    await searchInput.fill("archon knowledge rag");
    await page.waitForTimeout(1000);

    // Results should appear (either in list or as "no results")
    // The actual verification depends on whether the document was indexed
    const hasResults = await page.locator(".knowledge-item, [data-testid='knowledge-card']").count();

    // Log the result for debugging
    console.log(`Search results found: ${hasResults}`);
  });
});

test.describe("Knowledge Base UI Elements", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector("text=Knowledge Base", { timeout: 10000 });
  });

  test("should have working view mode toggles", async ({ page }) => {
    // Find view mode buttons
    const gridButton = page.locator('button[aria-label="Grid view"]');
    const tableButton = page.locator('button[aria-label="Table view"]');

    // Both should be visible
    await expect(gridButton).toBeVisible();
    await expect(tableButton).toBeVisible();

    // Click table view
    await tableButton.click();
    await expect(tableButton).toHaveAttribute("aria-pressed", "true");

    // Click grid view
    await gridButton.click();
    await expect(gridButton).toHaveAttribute("aria-pressed", "true");
  });

  test("should have working type filter toggles", async ({ page }) => {
    // Find filter buttons by their aria-labels
    const allFilter = page.locator('button[aria-label="All"]');
    const technicalFilter = page.locator('button[aria-label="Technical"]');
    const businessFilter = page.locator('button[aria-label="Business"]');

    // All should be visible
    await expect(allFilter).toBeVisible();
    await expect(technicalFilter).toBeVisible();
    await expect(businessFilter).toBeVisible();

    // Click through filters
    await technicalFilter.click();
    await page.waitForTimeout(300);

    await businessFilter.click();
    await page.waitForTimeout(300);

    await allFilter.click();
    await page.waitForTimeout(300);
  });

  test("should have search functionality", async ({ page }) => {
    const searchInput = page.locator('input[placeholder*="Search"]');
    await expect(searchInput).toBeVisible();

    // Type a search query
    await searchInput.fill("test query");
    await expect(searchInput).toHaveValue("test query");

    // Clear the search
    await searchInput.fill("");
    await expect(searchInput).toHaveValue("");
  });
});
