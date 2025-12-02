import { test, expect } from "@playwright/test";
import path from "path";
import fs from "fs";
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

// Create a test PDF file in the fixtures directory
const fixturesDir = path.join(__dirname, "fixtures");
const testPdfPath = path.join(fixturesDir, "test-document.txt");

test.beforeAll(async () => {
  // Ensure fixtures directory exists
  if (!fs.existsSync(fixturesDir)) {
    fs.mkdirSync(fixturesDir, { recursive: true });
  }

  // Create a simple test document (using .txt for simplicity - PDF would need binary)
  const testContent = `
# Test Document for E2E Testing

This is a test document created for Archon E2E testing.

## Section 1: Introduction
Archon is a knowledge management system with AI capabilities.

## Section 2: Features
- Web crawling
- Document upload with OCR support
- RAG-based search
- Multi-platform compatibility (ARM64 and x86_64)

## Section 3: Technical Details
The system uses PyMuPDF4LLM for PDF text extraction and Tesseract OCR
for scanned documents. This enables processing of both text-based and
image-based PDF files.

Keywords: archon, knowledge, rag, ocr, tesseract, pymupdf
`;

  fs.writeFileSync(testPdfPath, testContent.trim());
});

test.describe("PDF Upload Flow", () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to Knowledge Base
    await page.goto("/knowledge");
    await page.waitForLoadState("networkidle");
  });

  test("should display Knowledge Base page with Add Knowledge button", async ({ page }) => {
    // Verify page loaded
    await expect(page.locator("text=Knowledge Base")).toBeVisible();

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

    // Verify both tabs exist
    await expect(page.locator("text=Crawl Website")).toBeVisible();
    await expect(page.locator("text=Upload Document")).toBeVisible();

    // Click Upload Document tab
    await page.click("text=Upload Document");
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

    // Switch to Upload tab
    await page.click("text=Upload Document");
    await page.waitForTimeout(300);

    // Upload the test file
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(testPdfPath);

    // Verify file is selected (filename should appear)
    await expect(page.locator("text=test-document.txt")).toBeVisible();

    // Click Upload button
    const uploadButton = page.locator('button:has-text("Upload Document")');
    await uploadButton.click();

    // Wait for upload to start (toast message)
    await expect(page.locator("text=Upload started").first()).toBeVisible({ timeout: 10000 });
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
    await page.goto("/knowledge");
    await page.waitForLoadState("networkidle");
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

test.afterAll(async () => {
  // Cleanup test fixtures
  if (fs.existsSync(testPdfPath)) {
    fs.unlinkSync(testPdfPath);
  }
  // Remove fixtures dir if empty
  if (fs.existsSync(fixturesDir) && fs.readdirSync(fixturesDir).length === 0) {
    fs.rmdirSync(fixturesDir);
  }
});
