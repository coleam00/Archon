import { test, expect } from '@playwright/test';

test.describe('Ollama API Mode Selection', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:3737/settings');
    await page.waitForLoadState('networkidle');
  });

  test('should display API mode radio buttons when Ollama is selected', async ({ page }) => {
    // Navigate to RAG Settings tab
    await page.locator('text=RAG Settings').click();
    await expect(page.locator('text=Embedding')).toBeVisible();

    // Select Ollama as embedding provider
    await page.locator('text=Embedding').click();
    await expect(page.locator('button:has-text("Ollama")').first()).toBeVisible();

    // Click on Ollama provider card
    await page.locator('button:has-text("Ollama")').first().click();
    await expect(page.locator('button:has-text("Config")').first()).toBeVisible();

    // Open Ollama configuration
    await page.locator('button:has-text("Config")').first().click();

    // Verify API mode section is visible
    await expect(page.locator('text=Ollama API Mode')).toBeVisible();

    // Verify both radio options are visible
    await expect(page.locator('text=Native Ollama API')).toBeVisible();
    await expect(page.locator('text=OpenAI-Compatible')).toBeVisible();

    // Verify descriptions are visible
    await expect(page.locator('text=Uses /api/embeddings endpoint')).toBeVisible();
    await expect(page.locator('text=Uses /v1/embeddings endpoint')).toBeVisible();
  });

  test('should default to Native Ollama API mode', async ({ page }) => {
    // Navigate to RAG Settings tab
    await page.locator('text=RAG Settings').click();
    await expect(page.locator('text=Embedding')).toBeVisible();

    // Select Ollama as embedding provider
    await page.locator('text=Embedding').click();
    await expect(page.locator('button:has-text("Ollama")').first()).toBeVisible();

    await page.locator('button:has-text("Ollama")').first().click();
    await expect(page.locator('button:has-text("Config")').first()).toBeVisible();

    // Open Ollama configuration
    await page.locator('button:has-text("Config")').first().click();

    // Wait for the API mode section to be visible
    await expect(page.locator('text=Ollama API Mode')).toBeVisible();

    // Verify Native Ollama API is selected by default (check for the green border or the filled radio)
    const nativeButton = page.locator('button:has-text("Native Ollama API")');
    const nativeRadioCircle = nativeButton.locator('div.w-2.h-2.rounded-full.bg-green-500');

    // Either check the class or the radio circle visibility
    await expect(nativeRadioCircle).toBeVisible();
  });

  test('should switch between API modes', async ({ page }) => {
    // Navigate to RAG Settings tab
    await page.locator('text=RAG Settings').click();
    await expect(page.locator('text=Embedding')).toBeVisible();

    // Select Ollama as embedding provider
    await page.locator('text=Embedding').click();
    await expect(page.locator('button:has-text("Ollama")').first()).toBeVisible();

    await page.locator('button:has-text("Ollama")').first().click();
    await expect(page.locator('button:has-text("Config")').first()).toBeVisible();

    // Open Ollama configuration
    await page.locator('button:has-text("Config")').first().click();
    await expect(page.locator('text=Ollama API Mode')).toBeVisible();

    // Click on OpenAI-Compatible mode
    const openaiButton = page.locator('button:has-text("OpenAI-Compatible")');
    await openaiButton.click();

    // Verify OpenAI-Compatible is now selected
    await expect(openaiButton).toHaveClass(/border-green-500/);
    const openaiRadioCircle = openaiButton.locator('div.w-2.h-2.rounded-full.bg-green-500');
    await expect(openaiRadioCircle).toBeVisible();

    // Verify Native is not selected
    const nativeButton = page.locator('button:has-text("Native Ollama API")');
    await expect(nativeButton).not.toHaveClass(/border-green-500/);

    // Switch back to Native
    await nativeButton.click();

    // Verify Native is selected again
    await expect(nativeButton).toHaveClass(/border-green-500/);
    const nativeRadioCircle = nativeButton.locator('div.w-2.h-2.rounded-full.bg-green-500');
    await expect(nativeRadioCircle).toBeVisible();

    // Verify OpenAI-Compatible is not selected
    await expect(openaiButton).not.toHaveClass(/border-green-500/);
  });

  test('should persist API mode selection after save', async ({ page }) => {
    // Navigate to RAG Settings tab
    await page.locator('text=RAG Settings').click();
    await expect(page.locator('text=Embedding')).toBeVisible();

    // Select Ollama as embedding provider
    await page.locator('text=Embedding').click();
    await expect(page.locator('button:has-text("Ollama")').first()).toBeVisible();

    await page.locator('button:has-text("Ollama")').first().click();
    await expect(page.locator('button:has-text("Config")').first()).toBeVisible();

    // Open Ollama configuration
    await page.locator('button:has-text("Config")').first().click();
    await expect(page.locator('text=Ollama API Mode')).toBeVisible();

    // Select OpenAI-Compatible mode
    const openaiButton = page.locator('button:has-text("OpenAI-Compatible")');
    await openaiButton.click();
    await expect(openaiButton).toHaveClass(/border-green-500/);

    // Save settings
    await page.locator('button:has-text("Save Settings")').click();

    // Verify success toast (use first() to avoid strict mode violation)
    await expect(page.locator('text=RAG settings saved successfully!').first()).toBeVisible({ timeout: 5000 });

    // Reload the page
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Navigate back to RAG Settings
    await page.locator('text=RAG Settings').click();
    await expect(page.locator('text=Embedding')).toBeVisible();

    await page.locator('text=Embedding').click();
    await expect(page.locator('button:has-text("Config")').first()).toBeVisible();

    // Open Ollama configuration
    await page.locator('button:has-text("Config")').first().click();
    await expect(page.locator('text=Ollama API Mode')).toBeVisible();

    // Verify OpenAI-Compatible is still selected after reload
    const openaiButtonAfterReload = page.locator('button:has-text("OpenAI-Compatible")');
    await expect(openaiButtonAfterReload).toHaveClass(/border-green-500/);
  });

  test('should show API mode for both chat and embedding configurations', async ({ page }) => {
    // Navigate to RAG Settings tab
    await page.locator('text=RAG Settings').click();
    await expect(page.locator('text=Chat')).toBeVisible();

    // Test with Chat tab
    await page.locator('text=Chat').click();
    await expect(page.locator('button:has-text("Ollama")').first()).toBeVisible();

    await page.locator('button:has-text("Ollama")').first().click();
    await expect(page.locator('button:has-text("Config")').first()).toBeVisible();

    await page.locator('button:has-text("Config")').first().click();

    // Verify API mode section is visible for chat
    await expect(page.locator('text=Ollama API Mode')).toBeVisible();

    // Switch to Embedding tab
    await page.locator('text=Embedding').click();
    await expect(page.locator('text=Ollama API Mode')).toBeVisible();
  });
});
