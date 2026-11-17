import { test, expect } from '@playwright/test';
import { enterGuestWorkspace, isMobileViewport } from './helpers.ts';

test.describe('ORVIX-OPT-01 Responsive Layout & Accessibility Basics', () => {
  test('maintains zero horizontal overflow and proper ARIA landmarks across AuthScreen and Chat Workspace', async ({ page }) => {
    await page.goto('/');

    // AuthScreen overflow & landmark check
    const authOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth
    }));
    expect(authOverflow.scrollWidth).toBeLessThanOrEqual(authOverflow.innerWidth);
    await expect(page.locator('[role="tablist"]')).toBeVisible();

    await enterGuestWorkspace(page);

    // Core workspace ARIA landmarks & labels
    await expect(page.locator('main')).toBeVisible();
    await expect(page.locator('aside[aria-label="Sidebar navigation"]')).toBeAttached();
    await expect(page.locator('form[aria-label="Message composer"]')).toBeVisible();
    await expect(page.getByLabel('Message input')).toBeVisible();

    const workspaceOverflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth
    }));
    expect(workspaceOverflow.scrollWidth).toBeLessThanOrEqual(workspaceOverflow.innerWidth);
  });

  test('handles viewport-specific sidebar drawer state cleanly', async ({ page }) => {
    await enterGuestWorkspace(page);

    const sidebar = page.locator('aside.orvix-sidebar');
    if (await isMobileViewport(page)) {
      // Mobile: starts collapsed with aria-hidden="true", opens & closes via header/sidebar buttons
      await expect(sidebar).toHaveClass(/collapsed/);
      await expect(sidebar).toHaveAttribute('aria-hidden', 'true');

      const mobileToggle = page.getByRole('button', { name: 'Open chat history' });
      await expect(mobileToggle).toBeVisible();
      await mobileToggle.click();

      await expect(sidebar).not.toHaveClass(/collapsed/);
      await sidebar.getByRole('button', { name: 'Close sidebar' }).click();
      await expect(sidebar).toHaveClass(/collapsed/);
    } else {
      // Desktop: starts open
      await expect(sidebar).not.toHaveClass(/collapsed/);
      await page.getByRole('button', { name: 'Close sidebar' }).click();
      await expect(sidebar).toHaveClass(/collapsed/);
      await page.getByRole('button', { name: 'Expand sidebar' }).click();
      await expect(sidebar).not.toHaveClass(/collapsed/);
    }
  });
});
