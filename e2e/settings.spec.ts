import { test, expect } from '@playwright/test';
import { enterGuestWorkspace, ensureSidebarOpen } from './helpers.ts';

test.describe('ORVIX-OPT-01 Personalization Settings & Persistence', () => {
  test('opens SettingsModal, switches theme & toggles, persists across reload, and resets to defaults', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await enterGuestWorkspace(page);
    await ensureSidebarOpen(page);

    await page.locator('aside.orvix-sidebar button[aria-label="Personalization Settings"]').click();

    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Personalization Settings');

    // Switch theme to Light and confirm data-theme updates on <html>
    const themeGroup = dialog.getByRole('radiogroup', { name: 'Theme selection' });
    await themeGroup.getByRole('radio', { name: /Light/i }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    // Toggle composer and display switches
    const enterToggle = dialog.locator('#toggle-enter-to-send');
    const timestampsToggle = dialog.locator('#toggle-show-timestamps');
    const initialEnter = await enterToggle.getAttribute('aria-checked');
    const initialTimestamps = await timestampsToggle.getAttribute('aria-checked');

    await enterToggle.click();
    await timestampsToggle.click();
    await expect(enterToggle).toHaveAttribute('aria-checked', initialEnter === 'true' ? 'false' : 'true');
    await expect(timestampsToggle).toHaveAttribute('aria-checked', initialTimestamps === 'true' ? 'false' : 'true');

    // Close with Escape
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);

    // Reload page and confirm settings persisted in localStorage & DOM
    await page.reload();
    await expect(page.getByLabel('Message input')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

    // Re-open settings and verify switches persisted, then Reset to Defaults
    await ensureSidebarOpen(page);
    await page.locator('aside.orvix-sidebar button[aria-label="Personalization Settings"]').click();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('#toggle-enter-to-send')).toHaveAttribute(
      'aria-checked',
      initialEnter === 'true' ? 'false' : 'true'
    );

    await dialog.getByRole('button', { name: /Restore factory default preferences/i }).click();
    await expect(dialog.getByRole('alertdialog', { name: 'Confirm settings reset' })).toBeVisible();
    await dialog.getByRole('button', { name: /Yes, Reset/i }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(dialog.locator('#toggle-enter-to-send')).toHaveAttribute('aria-checked', String(initialEnter));
    await expect(dialog.locator('#toggle-show-timestamps')).toHaveAttribute('aria-checked', String(initialTimestamps));
  });
});
