import { test, expect } from '@playwright/test';
import {
  enterGuestWorkspace,
  ensureSidebarOpen,
  ensureSidebarClosedIfMobile,
  installWebGPUStub,
  configureDeterministicWebLLMStream
} from './helpers.ts';

test.describe('ORVIX-OPT-01 Chat Interactions, Streaming Markdown & History Management', () => {
  test('renders sample conversation with Markdown and CodeBlock copy interaction', async ({ page }) => {
    await enterGuestWorkspace(page);
    await ensureSidebarOpen(page);

    await page.getByText('React state management advice').first().click();
    await ensureSidebarClosedIfMobile(page);

    const log = page.locator('[role="log"]');
    await expect(log).toContainText('When should I choose Zustand over React Context for a web app?');
    await expect(log).toContainText('Minimal Zustand store example');

    // Verify syntax-highlighted CodeBlock renders with JavaScript label & Copy control
    const codeBlock = log.locator('.code-block-container, .code-block-wrapper').first();
    await expect(codeBlock).toBeVisible();
    await expect(codeBlock).toContainText('JavaScript');

    const copyBtn = codeBlock.getByRole('button', { name: /Copy code/i });
    await expect(copyBtn).toBeVisible();
    await copyBtn.click();
    await expect(codeBlock).toContainText(/Copied/i);
  });

  test('streams deterministic Markdown tokens, renders table/code block, and persists chat across reload', async ({ page }) => {
    await installWebGPUStub(page);
    await enterGuestWorkspace(page);

    const markdownChunks = [
      '## Architecture Summary\n\n',
      'Here is a structured overview:\n\n',
      '| Layer | Role |\n| :--- | :--- |\n| UI | React 19 |\n| Inference | Deterministic Stream |\n\n',
      '```javascript\n',
      'export function greet(name) {\n',
      '  return `Hello, ${name}`;\n',
      '}\n',
      '```\n'
    ];
    await configureDeterministicWebLLMStream(page, markdownChunks, { chunkDelayMs: 25 });

    const composer = page.getByLabel('Message input');
    await composer.fill('Explain the architecture with a table and snippet');
    await composer.press('Enter');

    const log = page.locator('[role="log"]');
    await expect(log).toContainText('Explain the architecture with a table and snippet');
    await expect(log.locator('h2')).toHaveText('Architecture Summary');
    await expect(log.locator('table')).toContainText('React 19');
    await expect(log.locator('table')).toContainText('Deterministic Stream');
    await expect(log.locator('pre code')).toContainText('export function greet(name)');

    // Confirm conversation was saved into sidebar & persists after page reload
    await page.reload();
    await expect(page.getByLabel('Message input')).toBeVisible();
    await ensureSidebarOpen(page);
    await expect(page.locator('aside.orvix-sidebar')).toContainText('Architecture Summary');
  });

  test('switches chat modes via ModeSelector and searches, pins, renames, and deletes chats in sidebar', async ({ page }) => {
    await enterGuestWorkspace(page);

    // Switch mode via visible ModeSelector trigger (desktop header vs mobile sub-header)
    const modeTrigger = page.locator('button.mode-compact-trigger:visible').first();
    await modeTrigger.click();
    const modeMenu = page.getByRole('menu', { name: 'Conversation modes' });
    await expect(modeMenu).toBeVisible();
    await modeMenu.getByRole('radio', { name: /Coding/i }).click();
    await expect(modeTrigger).toContainText('Coding');

    // Open sidebar and verify search filtering
    await ensureSidebarOpen(page);
    const searchInput = page.getByLabel('Search conversations');
    await searchInput.fill('quantum');
    await expect(page.locator('aside.orvix-sidebar')).toContainText('Explain quantum computing simply');
    await expect(page.locator('aside.orvix-sidebar')).not.toContainText('Creative startup taglines');
    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(page.locator('aside.orvix-sidebar')).toContainText('Creative startup taglines');

    // Pin a conversation and verify Pinned section updates
    const firstChat = page.locator('.recent-chat-item-container', { hasText: 'Creative startup taglines' }).first();
    await firstChat.hover();
    await firstChat.getByRole('button', { name: 'Pin chat' }).click();
    await expect(page.locator('.pinned-chats-section')).toContainText('Creative startup taglines');

    // Rename the pinned conversation
    const pinnedItem = page.locator('.pinned-chats-section .recent-chat-item-container', { hasText: 'Creative startup taglines' });
    await pinnedItem.hover();
    await pinnedItem.getByRole('button', { name: /Rename Creative startup taglines/i }).click();
    const renameInput = page.getByLabel('Rename conversation');
    await renameInput.fill('Renamed Brand Taglines');
    await renameInput.press('Enter');
    await expect(page.locator('.pinned-chats-section')).toContainText('Renamed Brand Taglines');

    // Delete with two-step confirmation
    const renamedItem = page.locator('.pinned-chats-section .recent-chat-item-container', { hasText: 'Renamed Brand Taglines' });
    await renamedItem.hover();
    await renamedItem.getByRole('button', { name: /Delete Renamed Brand Taglines/i }).click();
    await page.getByRole('button', { name: /Confirm delete Renamed Brand Taglines/i }).click();
    await expect(page.locator('aside.orvix-sidebar')).not.toContainText('Renamed Brand Taglines');
  });

  test('shows actionable error when WebGPU is unavailable and restores prompt on Edit prompt', async ({ page }) => {
    // Explicitly ensure navigator.gpu is absent so WebGPU unavailability path is deterministic
    await page.addInitScript(() => {
      try {
        Object.defineProperty(navigator, 'gpu', {
          configurable: true,
          value: undefined
        });
      } catch {
        // Ignore
      }
    });

    await enterGuestWorkspace(page);
    const composer = page.getByLabel('Message input');
    await composer.fill('Test error recovery prompt');
    await composer.press('Enter');

    const log = page.locator('[role="log"]');
    await expect(log).toContainText(/WebGPU/i);

    const editPromptBtn = log.getByRole('button', { name: /Restore prompt into composer/i });
    await expect(editPromptBtn).toBeVisible();
    await editPromptBtn.click();
    await expect(composer).toHaveValue('Test error recovery prompt');
  });
});
