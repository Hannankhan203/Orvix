import { expect, type Page } from '@playwright/test';

export async function enterGuestWorkspace(page: Page) {
  await page.goto('/');
  const guestBtn = page.getByRole('button', { name: /Continue as Guest/i });
  await expect(guestBtn).toBeVisible();
  await guestBtn.click();
  await expect(page.getByLabel('Message input')).toBeVisible();
}

export async function isMobileViewport(page: Page): Promise<boolean> {
  const viewport = page.viewportSize();
  return Boolean(viewport && viewport.width < 768);
}

export async function ensureSidebarOpen(page: Page) {
  const sidebar = page.locator('aside.orvix-sidebar');
  const isCollapsed = await sidebar.evaluate((el) => el.classList.contains('collapsed'));
  if (isCollapsed) {
    const openBtn = page.getByRole('button', { name: /Open chat history|Open sidebar/i }).first();
    await openBtn.click();
    await expect(sidebar).not.toHaveClass(/collapsed/);
  }
}

export async function ensureSidebarClosedIfMobile(page: Page) {
  if (!(await isMobileViewport(page))) return;
  const sidebar = page.locator('aside.orvix-sidebar');
  const isCollapsed = await sidebar.evaluate((el) => el.classList.contains('collapsed'));
  if (!isCollapsed) {
    await page.getByRole('button', { name: 'Close sidebar' }).click();
    await expect(sidebar).toHaveClass(/collapsed/);
  }
}

/**
 * Installs a deterministic WebGPU adapter stub prior to page scripts so
 * checkWebGPUSupport() resolves cleanly in headless Chromium without real GPU hardware.
 */
export async function installWebGPUStub(page: Page) {
  await page.addInitScript(() => {
    const mockAdapter = {
      features: new Set(['shader-f16']),
      limits: {
        maxStorageBufferBindingSize: 2147483648,
        maxBufferSize: 2147483648
      },
      info: {
        vendor: 'orvix-playwright',
        architecture: 'deterministic-test',
        description: 'Playwright Deterministic WebGPU'
      },
      isFallbackAdapter: false
    };

    try {
      Object.defineProperty(navigator, 'gpu', {
        configurable: true,
        value: {
          requestAdapter: async () => mockAdapter
        }
      });
    } catch {
      // Ignore if environment marks navigator.gpu non-configurable
    }
  });
}

/**
 * Registers deterministic WebLLM worker & engine factories on the loaded
 * Vite ES module so prompt submissions stream realistic Markdown chunks
 * through the real React ChatPage -> aiRouter -> webllmService -> MarkdownContent pipeline.
 */
export async function configureDeterministicWebLLMStream(
  page: Page,
  chunks: string[],
  options: { chunkDelayMs?: number } = {}
) {
  const chunkDelayMs = options.chunkDelayMs ?? 15;
  await page.evaluate(
    async ({ responseChunks, delayMs }) => {
      const moduleUrl = '/src/services/webllmService.js';
      const mod = (await import(/* @vite-ignore */ moduleUrl)) as {
        resetWebLLMRuntimeForTesting: () => void;
        setWebLLMWorkerFactoryForTesting: (factory: () => EventTarget) => void;
        setWebLLMEngineFactoryForTesting: (
          factory: (ctx: {
            handleInitProgress?: (report: { progress: number; text: string }) => void;
          }) => Promise<unknown>
        ) => void;
      };
      mod.resetWebLLMRuntimeForTesting();
      mod.setWebLLMWorkerFactoryForTesting(() => {
        const target = new EventTarget() as EventTarget & {
          postMessage: () => void;
          terminate: () => void;
          onmessage: null | ((ev: MessageEvent) => void);
          onerror: null | ((ev: Event) => void);
          onmessageerror: null | ((ev: Event) => void);
        };
        target.postMessage = () => {};
        target.terminate = () => {};
        target.onmessage = null;
        target.onerror = null;
        target.onmessageerror = null;
        return target;
      });
      mod.setWebLLMEngineFactoryForTesting(async ({ handleInitProgress }) => {
        handleInitProgress?.({
          progress: 1,
          text: 'Finish loading on device'
        });
        return {
          interruptGenerate: () => {},
          unload: async () => {},
          chat: {
            completions: {
              create: async ({ stream }: { stream?: boolean }) => {
                if (!stream) {
                  return {
                    choices: [{ message: { content: responseChunks.join('') } }]
                  };
                }
                async function* chunkGenerator() {
                  for (const piece of responseChunks) {
                    if (delayMs > 0) {
                      await new Promise((r) => setTimeout(r, delayMs));
                    }
                    yield {
                      choices: [{ delta: { content: piece } }]
                    };
                  }
                }
                return chunkGenerator();
              }
            }
          }
        };
      });
    },
    { responseChunks: chunks, delayMs: chunkDelayMs }
  );
}
