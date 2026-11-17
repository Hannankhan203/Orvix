import { test, expect } from '@playwright/test';
import { enterGuestWorkspace, ensureSidebarOpen, isMobileViewport } from './helpers.ts';

test.describe('ORVIX-OPT-01 Authentication & Guest Session Flows', () => {
  test('renders AuthScreen, switches between Sign In and Create Account tabs, and surfaces demo readiness', async ({ page }) => {
    await page.goto('/');

    const heading = page.locator('h1.auth-brand-title');
    await expect(heading).toHaveText('Welcome back');

    const signInTab = page.getByRole('tab', { name: 'Sign In' });
    const createTab = page.getByRole('tab', { name: 'Create Account' });
    await expect(signInTab).toHaveAttribute('aria-selected', 'true');
    await expect(createTab).toHaveAttribute('aria-selected', 'false');

    // Switch to Create Account tab and confirm username field appears
    await createTab.click();
    await expect(createTab).toHaveAttribute('aria-selected', 'true');
    await expect(heading).toHaveText('Create your account');
    await expect(page.locator('#auth-username')).toBeVisible();
    await expect(page.locator('#auth-email')).toBeVisible();
    await expect(page.locator('#auth-password')).toBeVisible();

    // Password visibility toggle works cleanly
    const passwordInput = page.locator('#auth-password');
    await expect(passwordInput).toHaveAttribute('type', 'password');
    await page.getByRole('button', { name: 'Show password' }).click();
    await expect(passwordInput).toHaveAttribute('type', 'text');

    // Switch back via footer link
    await page.locator('.auth-footer button.auth-link-btn').click();
    await expect(signInTab).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#auth-username')).toHaveCount(0);
  });

  test('continues as Guest Explorer, persists session across page reload, and signs out cleanly', async ({ page }) => {
    await enterGuestWorkspace(page);

    // Guest session stored in both sessionStorage and localStorage
    const storedSession = await page.evaluate(() => ({
      session: sessionStorage.getItem('orvix_guest_session'),
      local: localStorage.getItem('orvix_guest_session')
    }));
    expect(storedSession.session).toBeTruthy();
    expect(storedSession.local).toBeTruthy();

    // Verify welcome heading and Guest Explorer session identity
    await expect(page.locator('h1.welcome-heading')).toHaveText('What can I help you with today?');
    if (await isMobileViewport(page)) {
      await ensureSidebarOpen(page);
      await expect(page.locator('aside.orvix-sidebar')).toContainText('Guest Explorer');
    } else {
      await expect(page.locator('button.desktop-user-trigger')).toContainText('Guest Explorer');
    }

    // Reload page and confirm guest session persists without falling back to AuthScreen
    await page.reload();
    await expect(page.getByLabel('Message input')).toBeVisible();
    await expect(page.locator('h1.auth-brand-title')).toHaveCount(0);

    // Sign out via header account menu or sidebar
    if (await isMobileViewport(page)) {
      await ensureSidebarOpen(page);
      await page.locator('aside.orvix-sidebar button[aria-label="Sign out"]').click();
    } else {
      const accountTrigger = page.locator('button.desktop-user-trigger');
      await accountTrigger.click();
      await page.getByRole('button', { name: /Sign out of Orvix/i }).click();
    }

    // Returned cleanly to AuthScreen and storage cleared
    await expect(page.locator('h1.auth-brand-title')).toHaveText('Welcome back');
    const clearedSession = await page.evaluate(() => ({
      session: sessionStorage.getItem('orvix_guest_session'),
      local: localStorage.getItem('orvix_guest_session')
    }));
    expect(clearedSession.session).toBeNull();
    expect(clearedSession.local).toBeNull();
  });
});
