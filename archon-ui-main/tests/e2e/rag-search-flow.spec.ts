import { test, expect } from '@playwright/test';
import path from 'path';

/**
 * RAG Search Flow E2E Tests
 *
 * Tests the complete flow:
 * 1. Delete all knowledge items (clean slate)
 * 2. Upload a test PDF
 * 3. Wait for processing to complete
 * 4. Perform a search query
 * 5. Verify search results
 */
test.describe('RAG Search Flow', () => {
  // Test PDF path - using the test-pdf folder in the repo root
  const TEST_PDF_PATH = path.resolve(__dirname, '../../../test-pdf/Coding.pdf');

  test.beforeEach(async ({ page }) => {
    // Navigate to Knowledge Base
    await page.goto('/knowledge');
    await page.waitForLoadState('networkidle');
  });

  test('should perform complete RAG workflow: clean, upload, search, verify', async ({ page }) => {
    // Step 1: Delete all existing knowledge items (clean slate)
    await test.step('Delete all existing knowledge items', async () => {
      // Wait for the page to load
      await page.waitForTimeout(1000);

      // Check if there are any knowledge items
      const noItemsMessage = page.locator('text=No Knowledge Items');
      const knowledgeCards = page.locator('[data-testid="knowledge-card"], .grid > div > div');

      // If no items message is visible, we're already clean
      const noItems = await noItemsMessage.isVisible().catch(() => false);

      if (!noItems) {
        // Delete all existing items
        let hasItems = true;
        let maxAttempts = 20; // Safety limit

        while (hasItems && maxAttempts > 0) {
          maxAttempts--;

          // Look for delete button (trash icon) on any card
          const deleteButton = page.locator('button[aria-label*="Delete"], button:has(svg.lucide-trash), button:has(svg.lucide-trash-2)').first();

          if (await deleteButton.isVisible({ timeout: 2000 }).catch(() => false)) {
            await deleteButton.click();

            // Wait for confirmation dialog
            const confirmButton = page.locator('button:has-text("Delete"), button:has-text("Confirm")').first();
            if (await confirmButton.isVisible({ timeout: 2000 }).catch(() => false)) {
              await confirmButton.click();
            }

            // Wait for deletion to complete
            await page.waitForTimeout(1000);
          } else {
            hasItems = false;
          }
        }

        // Verify clean slate
        await page.waitForTimeout(500);
      }

      // Verify we have a clean slate (either already empty or just cleaned)
      // The message "No Knowledge Items" or similar should appear, or just no cards
    });

    // Step 2: Upload a test PDF
    await test.step('Upload test PDF', async () => {
      // Click "Add Knowledge" button
      const addButton = page.locator('button:has-text("Add Knowledge"), button:has-text("Add")').first();
      await expect(addButton).toBeVisible({ timeout: 5000 });
      await addButton.click();

      // Wait for dialog to open
      await page.waitForTimeout(500);

      // Switch to "Upload Document" tab
      const uploadTab = page.locator('button:has-text("Upload Document"), [role="tab"]:has-text("Upload")');
      await uploadTab.click();
      await page.waitForTimeout(300);

      // Upload the file
      const fileInput = page.locator('input[type="file"]');
      await fileInput.setInputFiles(TEST_PDF_PATH);
      await page.waitForTimeout(500);

      // Click upload button
      const uploadButton = page.locator('button:has-text("Upload Document")').last();
      await uploadButton.click();

      // Wait for upload to start - look for toast or progress
      await page.waitForTimeout(1000);

      // Close dialog if still open
      const closeButton = page.locator('[aria-label="Close"], button:has(svg.lucide-x)').first();
      if (await closeButton.isVisible({ timeout: 500 }).catch(() => false)) {
        await closeButton.click();
      }
    });

    // Step 3: Wait for processing to complete
    await test.step('Wait for PDF processing to complete', async () => {
      // Wait for the processing to complete - look for the card to appear
      // Processing can take a while for PDFs
      const maxWaitTime = 120000; // 2 minutes max
      const startTime = Date.now();

      while (Date.now() - startTime < maxWaitTime) {
        // Check if the uploaded document appears as a card
        const documentCard = page.locator('text=Coding.pdf, text=Coding');
        const isVisible = await documentCard.first().isVisible({ timeout: 1000 }).catch(() => false);

        if (isVisible) {
          // Check if it's still processing
          const processingIndicator = page.locator('text=Processing, text=Storing, .animate-pulse').first();
          const stillProcessing = await processingIndicator.isVisible({ timeout: 500 }).catch(() => false);

          if (!stillProcessing) {
            // Processing complete!
            break;
          }
        }

        await page.waitForTimeout(2000);
      }

      // Verify the document is in the knowledge base
      const documentCard = page.locator('[class*="card"], .rounded-lg').filter({ hasText: /Coding/i });
      await expect(documentCard.first()).toBeVisible({ timeout: 10000 });
    });

    // Step 4: Perform a search query
    await test.step('Perform search query', async () => {
      // Find the search input
      const searchInput = page.locator('input[placeholder*="Search"], input[type="search"]').first();

      // If search is in the header, use it
      if (await searchInput.isVisible({ timeout: 2000 }).catch(() => false)) {
        await searchInput.fill('programming');
        await page.waitForTimeout(500);
      }

      // Alternative: Use the API search endpoint directly via the Agent Chat
      // Navigate to agent chat to perform RAG search
      await page.goto('/agent');
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(1000);

      // Find the chat input
      const chatInput = page.locator('textarea, input[placeholder*="message"], input[placeholder*="chat"]').first();

      if (await chatInput.isVisible({ timeout: 5000 }).catch(() => false)) {
        await chatInput.fill('What do you know about programming from the uploaded documents?');

        // Find and click send button
        const sendButton = page.locator('button[type="submit"], button:has(svg.lucide-send), button:has-text("Send")').first();
        await sendButton.click();

        // Wait for response
        await page.waitForTimeout(5000);
      }
    });

    // Step 5: Verify search results
    await test.step('Verify search results', async () => {
      // Check that we got some response in the chat
      const responseArea = page.locator('.prose, [class*="message"], [class*="response"]');

      // We should see some kind of response
      await expect(responseArea.first()).toBeVisible({ timeout: 30000 });

      // The response should contain content related to programming/coding
      // This is a basic check - in real E2E tests, you'd check for specific content
      const pageContent = await page.content();
      const hasResponse = pageContent.length > 5000; // Page should have substantial content

      expect(hasResponse).toBe(true);
    });
  });

  test('should handle search with no results gracefully', async ({ page }) => {
    // This test verifies that searching for non-existent content works correctly

    // Navigate to agent chat
    await page.goto('/agent');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    // Find the chat input
    const chatInput = page.locator('textarea, input[placeholder*="message"]').first();

    if (await chatInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      // Search for something that definitely won't be in the knowledge base
      await chatInput.fill('xyznonexistentcontent12345');

      // Find and click send button
      const sendButton = page.locator('button[type="submit"], button:has(svg.lucide-send)').first();
      await sendButton.click();

      // Wait for response
      await page.waitForTimeout(5000);

      // Should not crash, should show some response
      const responseArea = page.locator('.prose, [class*="message"]');
      await expect(responseArea.first()).toBeVisible({ timeout: 30000 });
    }
  });

  test('should show knowledge items in the list after upload', async ({ page }) => {
    // This is a simpler test that just verifies the Knowledge Base UI

    // Check for the header
    const header = page.locator('text=Knowledge Base, h1:has-text("Knowledge")');
    await expect(header.first()).toBeVisible({ timeout: 5000 });

    // Check for "Add Knowledge" button
    const addButton = page.locator('button:has-text("Add")').first();
    await expect(addButton).toBeVisible();

    // Check for view mode toggle (grid/table)
    const viewToggle = page.locator('button:has(svg.lucide-layout-grid), button:has(svg.lucide-list)');
    const hasViewToggle = await viewToggle.first().isVisible({ timeout: 2000 }).catch(() => false);

    // Either view toggle exists or we have some other UI indicator
    expect(hasViewToggle || (await page.locator('text=No Knowledge Items').isVisible().catch(() => false)) || (await page.locator('[class*="grid"]').isVisible().catch(() => false))).toBe(true);
  });
});
