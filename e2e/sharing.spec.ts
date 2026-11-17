import { test, expect } from '@playwright/test';

const VALID_SHARE_ID = 'share_e2e_valid_123456';
const REVOKED_SHARE_ID = 'share_e2e_revoked_1234';
const EXPIRED_SHARE_ID = 'share_e2e_expired_1234';
const MISSING_SHARE_ID = 'share_e2e_missing_1234';

test.describe('ORVIX-OPT-01 & ORVIX-OPT-02 Shared Conversation Viewer & Revocation/Expiration', () => {
  test('renders active public shared snapshot in read-only mode with Markdown & locked composer', async ({ page }) => {
    await page.route(`**/api/share/${VALID_SHARE_ID}`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          snapshot: {
            shareId: VALID_SHARE_ID,
            title: 'Playwright Shared Engineering Notes',
            mode: 'coding',
            messageCount: 2,
            expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
            revoked: false,
            messages: [
              {
                id: 'u1',
                sender: 'user',
                content: 'Show a TypeScript utility function.',
                mode: 'coding',
                clientTimestamp: '10:00 AM'
              },
              {
                id: 'a1',
                sender: 'assistant',
                content: 'Here is the helper:\n\n```typescript\nexport const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));\n```',
                mode: 'coding',
                provider: 'gemini',
                modelUsed: 'gemini-2.5-flash',
                clientTimestamp: '10:00 AM'
              }
            ]
          }
        })
      });
    });

    await page.goto(`/share/${VALID_SHARE_ID}`);

    const banner = page.getByRole('region', { name: 'Shared conversation banner' });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('Shared Conversation · Read Only');

    const log = page.locator('[role="log"]');
    await expect(log).toContainText('Show a TypeScript utility function.');
    await expect(log).toContainText('export const clamp');

    // Read-only composer enforcement
    await expect(page.getByLabel('Message input')).toBeDisabled();
    await expect(page.locator('button.composer-send-btn')).toBeDisabled();

    // Sign In button in banner opens Auth modal
    await banner.getByRole('button', { name: 'Sign In' }).click();
    await expect(page.locator('h1.auth-brand-title')).toHaveText('Welcome back');
    await page.getByRole('button', { name: 'Close authentication dialog' }).click();
    await expect(page.locator('h1.auth-brand-title')).toHaveCount(0);
  });

  test('shows Share Link Revoked state when API returns 410 SHARE_REVOKED', async ({ page }) => {
    await page.route(`**/api/share/${REVOKED_SHARE_ID}`, async (route) => {
      await route.fulfill({
        status: 410,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'This shared conversation link has been revoked by its owner.',
          code: 'SHARE_REVOKED'
        })
      });
    });

    await page.goto(`/share/${REVOKED_SHARE_ID}`);

    const errorCard = page.locator('.shared-chat-error-card');
    await expect(errorCard).toBeVisible();
    await expect(errorCard.locator('.shared-error-title')).toHaveText('Share Link Revoked');
    await expect(errorCard).toContainText(/revoked/i);

    await errorCard.getByRole('button', { name: 'Go to Orvix Home' }).click();
    await expect(page).toHaveURL(/\/$/);
  });

  test('shows Share Link Expired state when API returns 410 SHARE_EXPIRED', async ({ page }) => {
    await page.route(`**/api/share/${EXPIRED_SHARE_ID}`, async (route) => {
      await route.fulfill({
        status: 410,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'This shared conversation link has expired.',
          code: 'SHARE_EXPIRED'
        })
      });
    });

    await page.goto(`/share/${EXPIRED_SHARE_ID}`);

    const errorCard = page.locator('.shared-chat-error-card');
    await expect(errorCard).toBeVisible();
    await expect(errorCard.locator('.shared-error-title')).toHaveText('Share Link Expired');
    await expect(errorCard).toContainText(/expired/i);
  });

  test('shows Shared Chat Unavailable for missing and malformed share links', async ({ page }) => {
    await page.route(`**/api/share/${MISSING_SHARE_ID}`, async (route) => {
      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'This shared conversation link could not be found.',
          code: 'NOT_FOUND'
        })
      });
    });

    await page.goto(`/share/${MISSING_SHARE_ID}`);
    await expect(page.locator('.shared-chat-error-card .shared-error-title')).toHaveText('Conversation Unavailable');

    await page.goto('/share/bad');
    await expect(page.locator('.shared-chat-error-card .shared-error-title')).toHaveText('Conversation Unavailable');
    await expect(page.locator('.shared-chat-error-card')).toContainText(/invalid or malformed/i);
  });

  test('enforces unauthenticated rejection and shareId validation on live /api/share endpoints', async ({ request }) => {
    const createRes = await request.post('/api/share', {
      data: { title: 'Test', messages: [{ id: '1', sender: 'user', content: 'hi' }] }
    });
    expect(createRes.status()).toBe(401);
    const createJson = await createRes.json();
    expect(createJson.code).toBe('AUTH_REQUIRED');

    const deleteRes = await request.delete(`/api/share/${VALID_SHARE_ID}`);
    expect(deleteRes.status()).toBe(401);

    const revokeRes = await request.post(`/api/share/${VALID_SHARE_ID}/revoke`);
    expect(revokeRes.status()).toBe(401);

    const malformedRes = await request.get('/api/share/bad');
    expect(malformedRes.status()).toBe(400);
    const malformedJson = await malformedRes.json();
    expect(malformedJson.code).toBe('INVALID_SHARE_ID');
  });
});
