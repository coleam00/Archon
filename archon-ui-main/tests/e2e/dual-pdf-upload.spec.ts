import { test, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_BASE = "http://localhost:8181/api";
const screenshotDir = path.resolve(__dirname, "../../upload-screenshots");

// Test PDFs
const bookPdfPath = path.resolve(__dirname, "../../../test-pdf/Book.pdf");
const codingPdfPath = path.resolve(__dirname, "../../../test-pdf/Coding.pdf");

/**
 * Cleanup all existing knowledge items
 */
async function cleanupAllItems(): Promise<void> {
  try {
    const response = await fetch(`${API_BASE}/knowledge-items/summary`);
    if (!response.ok) return;
    const data = await response.json();
    for (const item of data.items || []) {
      console.log(`Cleaning up: ${item.title} (${item.source_id})`);
      await fetch(`${API_BASE}/knowledge-items/${item.source_id}`, { method: "DELETE" });
    }
  } catch (error) {
    console.log("Cleanup skipped");
  }
}

test.describe("Dual PDF Upload Test", () => {
  test.setTimeout(600000); // 10 minutes for large PDFs

  test("Upload Book.pdf (Business) and Coding.pdf (Technical) with screenshots every 5 seconds", async ({ page }) => {
    // Cleanup first
    await cleanupAllItems();
    console.log("Cleanup complete - starting fresh");

    // Navigate to Knowledge Base
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector("text=Knowledge Base", { timeout: 10000 });

    let screenshotIndex = 1;
    const screenshot = async (name: string) => {
      const filename = `${String(screenshotIndex).padStart(2, "0")}-${name}.png`;
      await page.screenshot({ path: `${screenshotDir}/${filename}`, fullPage: true });
      console.log(`Screenshot ${screenshotIndex}: ${name}`);
      screenshotIndex++;
    };

    // Initial state
    await screenshot("initial-empty");

    // ===== UPLOAD 1: Book.pdf as Business =====
    console.log("\n=== Uploading Book.pdf as Business ===");

    // Open dialog
    const addButton = page.locator('button:has-text("Knowledge")').first();
    await addButton.click();
    await expect(page.locator("text=Add Knowledge")).toBeVisible();
    await screenshot("dialog-open");

    // Switch to Upload tab
    await page.getByRole("tab", { name: "Upload Document" }).click();
    await page.waitForTimeout(500);
    await screenshot("upload-tab-open");

    // Select Business type (it's a button, not radio)
    const businessButton = page.locator('button:has-text("Business")').first();
    await businessButton.click();
    await page.waitForTimeout(200);
    await screenshot("book-business-selected");

    // Upload Book.pdf
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(bookPdfPath);
    await page.waitForTimeout(500);
    await screenshot("book-file-selected");

    // Click Upload button
    const uploadButton = page.locator('button:has-text("Upload Document")').last();
    await uploadButton.click();
    console.log("Book.pdf upload started");

    // Wait a bit for the dialog to close
    await page.waitForTimeout(2000);
    await screenshot("book-upload-started");

    // ===== UPLOAD 2: Coding.pdf as Technical =====
    console.log("\n=== Uploading Coding.pdf as Technical ===");

    // Open dialog again
    await addButton.click();
    await expect(page.locator("text=Add Knowledge")).toBeVisible();

    // Switch to Upload tab
    await page.getByRole("tab", { name: "Upload Document" }).click();
    await page.waitForTimeout(500);

    // Select Technical type (it's a button, not radio)
    const technicalButton = page.locator('button:has-text("Technical")').first();
    await technicalButton.click();
    await page.waitForTimeout(200);
    await screenshot("coding-technical-selected");

    // Upload Coding.pdf - need fresh file input reference
    const fileInput2 = page.locator('input[type="file"]');
    await fileInput2.setInputFiles(codingPdfPath);
    await page.waitForTimeout(500);
    await screenshot("coding-file-selected");

    // Click Upload button
    const uploadButton2 = page.locator('button:has-text("Upload Document")').last();
    await uploadButton2.click();
    console.log("Coding.pdf upload started");

    // Wait a bit
    await page.waitForTimeout(2000);
    await screenshot("coding-upload-started");

    // ===== MONITORING: Take screenshots every 5 seconds =====
    console.log("\n=== Monitoring uploads with screenshots every 5 seconds ===");

    const startTime = Date.now();
    const maxDuration = 300000; // 5 minutes max
    let consecutiveNoOps = 0;

    while (Date.now() - startTime < maxDuration) {
      await page.waitForTimeout(5000);

      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      await screenshot(`progress-${elapsed}s`);

      // Check progress via API
      const progressResponse = await page.request.get(`${API_BASE}/progress/`).catch(() => null);
      const itemsResponse = await page.request.get(`${API_BASE}/knowledge-items/summary`).catch(() => null);

      if (progressResponse?.ok()) {
        const progress = await progressResponse.json();
        const activeOps = progress.operations?.filter((op: { status: string }) =>
          !["completed", "failed", "error", "cancelled"].includes(op.status)
        ) || [];

        console.log(`  Active operations: ${activeOps.length}`);
        for (const op of activeOps) {
          console.log(`    - ${op.operation_type}: ${op.status} ${op.progress}% - ${op.message || ""}`);
        }

        if (activeOps.length === 0) {
          consecutiveNoOps++;
          if (consecutiveNoOps >= 2) {
            console.log("No active operations for 10 seconds - uploads complete");
            break;
          }
        } else {
          consecutiveNoOps = 0;
        }
      }

      if (itemsResponse?.ok()) {
        const items = await itemsResponse.json();
        console.log(`  Knowledge items: ${items.items?.length || 0}`);
        for (const item of items.items || []) {
          console.log(`    - ${item.title}: ${item.knowledge_type}, ${item.document_count || 0} docs, ${item.status}`);
        }
      }
    }

    // Final screenshots
    await screenshot("final-state");
    await page.waitForTimeout(2000);
    await screenshot("final-state-2");

    // Log final summary
    const finalItems = await page.request.get(`${API_BASE}/knowledge-items/summary`);
    if (finalItems.ok()) {
      const items = await finalItems.json();
      console.log("\n=== FINAL SUMMARY ===");
      console.log(`Total items: ${items.items?.length || 0}`);
      for (const item of items.items || []) {
        console.log(`  ${item.title}:`);
        console.log(`    - Type: ${item.knowledge_type}`);
        console.log(`    - Status: ${item.status}`);
        console.log(`    - Documents: ${item.document_count || 0}`);
        console.log(`    - Code examples: ${item.code_examples_count || 0}`);
      }

      // Verify we have both items with correct types
      const bookItem = items.items?.find((i: { title: string }) => i.title === "Book.pdf");
      const codingItem = items.items?.find((i: { title: string }) => i.title === "Coding.pdf");

      expect(bookItem, "Book.pdf should exist").toBeTruthy();
      expect(codingItem, "Coding.pdf should exist").toBeTruthy();
      expect(bookItem?.knowledge_type, "Book.pdf should be Business").toBe("business");
      expect(codingItem?.knowledge_type, "Coding.pdf should be Technical").toBe("technical");
    }
  });
});
