import { test, expect } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Test PDF from repo
const testPdfPath = path.resolve(__dirname, "../../../test-pdf/Book.pdf");

test.describe("PDF Upload Debug with Screenshots", () => {
  // Long timeout for large PDF processing
  test.setTimeout(300000); // 5 minutes

  test("capture upload flow with screenshots every second", async ({ page }) => {
    // Create screenshot directory
    const screenshotDir = path.resolve(__dirname, "../../upload-screenshots");

    // Navigate to Knowledge Base
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector("text=Knowledge Base", { timeout: 10000 });

    // Screenshot 1: Initial state
    await page.screenshot({ path: `${screenshotDir}/01-initial.png`, fullPage: true });

    // Check backend health
    const healthCheck = await page.request.get("http://localhost:8181/health").catch(() => null);
    if (!healthCheck?.ok()) {
      test.skip(true, "Backend not available");
      return;
    }

    // Open Add Knowledge dialog
    const addButton = page.locator('button:has-text("Knowledge")').first();
    await addButton.click();
    await expect(page.locator("text=Add Knowledge")).toBeVisible();

    // Screenshot 2: Dialog open
    await page.screenshot({ path: `${screenshotDir}/02-dialog-open.png`, fullPage: true });

    // Switch to Upload tab
    await page.getByRole("tab", { name: "Upload Document" }).click();
    await page.waitForTimeout(300);

    // Screenshot 3: Upload tab
    await page.screenshot({ path: `${screenshotDir}/03-upload-tab.png`, fullPage: true });

    // Upload the test PDF file
    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles(testPdfPath);

    // Screenshot 4: File selected
    await page.screenshot({ path: `${screenshotDir}/04-file-selected.png`, fullPage: true });

    // Click Upload button
    const uploadButton = page.locator('button:has-text("Upload Document"):not([role="tab"])');
    await uploadButton.click();

    // Start taking screenshots every second until completion
    let screenshotIndex = 5;
    const startTime = Date.now();
    const maxDuration = 180000; // 3 minutes max (large PDFs need time)

    while (Date.now() - startTime < maxDuration) {
      await page.screenshot({
        path: `${screenshotDir}/${String(screenshotIndex).padStart(2, "0")}-progress-${Math.floor((Date.now() - startTime) / 1000)}s.png`,
        fullPage: true
      });
      screenshotIndex++;

      // Check for "Active Operations (X)" header - if count is 0 or section is gone, we're done
      const activeOpsHeader = page.locator("text=/Active Operations \\(\\d+\\)/");
      const hasActiveOps = await activeOpsHeader.isVisible().catch(() => false);

      // Also check for "No Active Operations" message
      const noActiveOps = await page.locator("text=No Active Operations").isVisible().catch(() => false);

      // If no more active operations, wait a bit for final state and take screenshots
      if (noActiveOps || !hasActiveOps) {
        console.log(`No active operations at ${Math.floor((Date.now() - startTime) / 1000)}s - upload completed`);
        // Take a few more screenshots to capture final state
        for (let i = 0; i < 3; i++) {
          await page.waitForTimeout(1000);
          await page.screenshot({
            path: `${screenshotDir}/${String(screenshotIndex).padStart(2, "0")}-completed-${i + 1}.png`,
            fullPage: true
          });
          screenshotIndex++;
        }
        break;
      }

      // Wait 2 seconds before next screenshot (reduce file count)
      await page.waitForTimeout(2000);
    }

    // Final screenshot
    await page.screenshot({ path: `${screenshotDir}/99-final.png`, fullPage: true });

    console.log(`Captured ${screenshotIndex} screenshots in ${screenshotDir}`);
  });
});
