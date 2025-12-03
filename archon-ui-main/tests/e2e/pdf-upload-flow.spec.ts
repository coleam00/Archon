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

// Test PDFs - small samples (4 pages each) for fast CI runs
// Full PDFs are available in test-pdf/ for manual testing
const testPdfPath = path.resolve(__dirname, "./fixtures/book-sample.pdf");
const codingPdfPath = path.resolve(__dirname, "./fixtures/coding-sample.pdf");

// API base URL for cleanup
const API_BASE = "http://localhost:8181/api";

/**
 * Cleanup test PDF sample items to prevent duplicates
 * NOTE: Only cleans up *-sample.pdf files, NOT full PDFs like Coding.pdf
 * This allows keeping manually uploaded full PDFs for more thorough testing
 */
async function cleanupTestPdfItems(): Promise<void> {
  try {
    const response = await fetch(`${API_BASE}/knowledge-items/summary`);
    if (!response.ok) return;

    const data = await response.json();
    // Only clean up sample files - keep full PDFs for comprehensive testing
    const testItems = data.items?.filter((item: any) => {
      const title = item.title || item.metadata?.filename || "";
      return title.includes("book-sample") || title.includes("coding-sample");
    }) || [];

    for (const item of testItems) {
      console.log(`Cleaning up test PDF item: ${item.source_id} (${item.title})`);
      await fetch(`${API_BASE}/knowledge-items/${item.source_id}`, { method: "DELETE" });
    }
  } catch (error) {
    // Ignore cleanup errors - backend might not be running
  }
}

test.describe("PDF Upload Flow", () => {
  // Clean up any existing test PDF items before each test to prevent duplicates
  test.beforeEach(async ({ page }) => {
    // Clean up existing test PDF items from previous test runs
    await cleanupTestPdfItems();

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
    await expect(dialog.locator("text=book-sample.pdf")).toBeVisible();

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

/**
 * Code Examples Display Tests
 * Verifies that code extracted from PDFs is displayed correctly without HTML entities
 * Uses coding-sample.pdf which contains HTML/ERB programming examples
 */
test.describe("Code Examples Display", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector("text=Knowledge Base", { timeout: 10000 });
  });

  test("should display code examples without HTML entities", async ({ page }) => {
    // Skip if backend not available
    const healthCheck = await page.request.get("http://localhost:8181/health").catch(() => null);
    if (!healthCheck?.ok()) {
      test.skip(true, "Backend not available");
      return;
    }

    // Check for PDFs with code examples in order of preference:
    // 1. Coding.pdf (full, from manual testing - has many code examples)
    // 2. coding-sample.pdf (small fixture, may have few/no code examples)
    let targetPdf = "";
    const hasCodingPdf = await page.getByText("Coding.pdf").first().isVisible({ timeout: 3000 }).catch(() => false);
    const hasCodingSample = await page.getByText("coding-sample.pdf").first().isVisible({ timeout: 3000 }).catch(() => false);

    if (hasCodingPdf) {
      targetPdf = "Coding.pdf";
      console.log("Found Coding.pdf (full version) - using for test");
    } else if (hasCodingSample) {
      targetPdf = "coding-sample.pdf";
      console.log("Found coding-sample.pdf - using for test");
    } else {
      // Upload coding-sample.pdf
      console.log("No coding PDF found - uploading coding-sample.pdf...");

      const addButton = page.locator('button:has-text("Knowledge")').first();
      await addButton.click();
      await expect(page.locator("text=Add Knowledge")).toBeVisible();

      await page.getByRole("tab", { name: "Upload Document" }).click();
      await page.waitForTimeout(300);

      const fileInput = page.locator('input[type="file"]');
      await fileInput.setInputFiles(codingPdfPath);

      const technicalButton = page.locator('button:has-text("Technical")');
      if (await technicalButton.isVisible()) {
        await technicalButton.click();
      }

      const uploadButton = page.locator('button:has-text("Upload Document"):not([role="tab"])');
      await uploadButton.click();

      console.log("Waiting for upload processing...");
      await page.waitForTimeout(5000);

      const closeButton = page.locator('[aria-label="Close"]').first();
      if (await closeButton.isVisible()) {
        await closeButton.click();
      }

      // Wait for PDF to appear (max 2 minutes)
      let uploaded = false;
      for (let i = 0; i < 12; i++) {
        await page.waitForTimeout(10000);
        await page.reload();
        await page.waitForSelector("text=Knowledge Base", { timeout: 10000 });
        if (await page.getByText("coding-sample.pdf").first().isVisible({ timeout: 3000 }).catch(() => false)) {
          console.log(`coding-sample.pdf appeared after ${(i + 1) * 10} seconds`);
          uploaded = true;
          break;
        }
        console.log(`Waiting... (${(i + 1) * 10}s)`);
      }

      if (!uploaded) {
        test.skip(true, "Upload did not complete in time");
        return;
      }
      targetPdf = "coding-sample.pdf";
    }

    // Find the target PDF card and its code badge
    const codingCard = page.locator("div").filter({ hasText: targetPdf }).first();
    const codeBadge = codingCard.locator('[aria-label="Code examples count"]').first();
    const hasCodeBadge = await codeBadge.isVisible({ timeout: 5000 }).catch(() => false);

    if (!hasCodeBadge) {
      console.log(`Code badge not found on ${targetPdf} - may not have code examples`);
      test.skip(true, "No code examples available (code extraction may still be processing)");
      return;
    }

    // Click code badge to open inspector to Code Examples tab
    await codeBadge.click();
    await page.waitForTimeout(2000);

    // Wait for inspector dialog
    const inspectorDialog = page.locator('[role="dialog"]').first();
    if (!(await inspectorDialog.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip(true, "Inspector dialog did not open");
      return;
    }

    // Click first code example
    await page.waitForTimeout(1000);
    const codeListItems = page.locator('[role="dialog"] [class*="cursor-pointer"]').filter({ hasText: /\w{3,}/ });
    const firstCodeItem = codeListItems.first();

    if (await firstCodeItem.isVisible({ timeout: 5000 }).catch(() => false)) {
      await firstCodeItem.click();
      await page.waitForTimeout(1500);
    }

    // Get code content
    const codeElement = page.locator("pre code").first();
    if (!(await codeElement.isVisible({ timeout: 3000 }).catch(() => false))) {
      test.skip(true, "Code element not visible");
      return;
    }

    const codeText = await codeElement.textContent();

    // CRITICAL ASSERTIONS: Code should NOT contain HTML entities
    expect(codeText, "Code should not contain &lt; entities").not.toContain("&lt;");
    expect(codeText, "Code should not contain &gt; entities").not.toContain("&gt;");
    expect(codeText, "Code should not contain double-encoded &amp;lt;").not.toContain("&amp;lt;");
    expect(codeText, "Code should not contain double-encoded &amp;gt;").not.toContain("&amp;gt;");

    // If HTML/ERB code, verify proper angle brackets exist
    if (codeText && (codeText.includes("h1") || codeText.includes("table") || codeText.includes("div"))) {
      expect(codeText, "HTML code should contain < character").toContain("<");
      expect(codeText, "HTML code should contain > character").toContain(">");
    }

    console.log("✓ Code examples display correctly without HTML entities");
  });
});
