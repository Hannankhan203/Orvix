import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

function safariLookbehindPlugin() {
  return {
    name: 'safari-lookbehind-sanitizer',
    transform(code: string, id: string) {
      if (id.includes('autolink') || id.includes('remark') || id.includes('mdast')) {
        if (code.includes('(?<=^|\\s|\\p{P}|\\p{S})')) {
          return {
            code: code.replace(/\(\?<=[\^|\s\\p\{P\}\\p\{S\}]+\)/g, ''),
            map: null
          };
        }
      }
      return null;
    }
  };
}

export default defineConfig(({ command, mode }) => {
  const isProdBuild = command === 'build' && mode !== 'development';

  // Ensure Vite core, @vitejs/plugin-react, and Oxc agree on production mode even if
  // the host/CI shell exports NODE_ENV=development during `vite build`.
  if (isProdBuild && process.env.NODE_ENV !== 'production') {
    process.env.NODE_ENV = 'production';
  }

  const isProdEnv = isProdBuild || process.env.NODE_ENV === 'production';

  return {
    plugins: [
      react({ jsxRuntime: 'automatic' }),
      tailwindcss(),
      safariLookbehindPlugin(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: [
          'favicon.ico',
          'favicon-32x32.png',
          'favicon.svg',
          'apple-touch-icon.png',
          'icon-192.png',
          'icon-512.png',
          'manifest.webmanifest'
        ],
        manifest: false,
        workbox: {
          clientsClaim: true,
          skipWaiting: true,
          globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest,wasm,woff2,woff,ttf}'],
          globIgnores: [
            '**/assets/webllmWorker-*.js',
            '**/assets/vendor-webllm-*.js',
            '**/assets/pdfExtractorWorker-*.js',
            '**/assets/vendor-pdfjs-*.js',
            '**/assets/pdfjs-*.js',
            '**/assets/vendor-pdf-lib-*.js',
            '**/assets/vendor-xlsx-*.js',
            '**/assets/vendor-mammoth-*.js',
            '**/assets/*oxipng*',
            '**/assets/worker-*.js'
          ],
          maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
          navigateFallback: '/index.html',
          navigateFallbackDenylist: [
            /^\/api\/.*/,
            /^\/health$/,
            /^\/chat$/,
            /^\/config$/,
            /^\/transcribe$/,
            /^\/upload(\/.*)?$/
          ],
          runtimeCaching: [
            {
              urlPattern: /^\/(api|health|chat|config|transcribe|upload)(\/.*)?$/i,
              handler: 'NetworkOnly'
            },
            {
              urlPattern: /^https:\/\/(firestore\.googleapis\.com|identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com)\/.*/i,
              handler: 'NetworkOnly'
            },
            {
              // Same-origin on-demand workers & lazy feature chunks (WebLLM worker, PDF.js, Office parsers, WASMs)
              // Excluded from eager install precache, then cached persistently on first use for offline PWA parity.
              urlPattern: ({ sameOrigin, url }) =>
                sameOrigin && /^\/assets\/.*\.(?:js|css|wasm)$/i.test(url.pathname),
              handler: 'CacheFirst',
              options: {
                cacheName: 'orvix-ondemand-assets',
                expiration: {
                  maxEntries: 64,
                  maxAgeSeconds: 30 * 24 * 60 * 60
                },
                cacheableResponse: {
                  statuses: [0, 200]
                }
              }
            }
            // Note: Cross-origin model weight hosts (huggingface.co, *.hf.co, raw.githubusercontent.com)
            // intentionally have NO Workbox route registered so sw.js does not call event.respondWith()
            // on large multi-shard binary streams or 302 CDN redirects. WebLLM manages its own Cache Storage.
          ]
        },
        devOptions: {
          enabled: false
        }
      })
    ],
    oxc: {
      jsx: {
        runtime: 'automatic',
        development: !isProdEnv,
      },
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify(isProdEnv ? 'production' : 'development'),
    },
    worker: {
      format: 'es',
    },
    build: {
      target: ['es2020', 'safari15'],
      chunkSizeWarningLimit: 600,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('node_modules')) {
              if (id.includes('/node_modules/firebase/') || id.includes('/node_modules/@firebase/')) {
                return 'vendor-firebase';
              }
              if (
                id.includes('/node_modules/react/') ||
                id.includes('/node_modules/react-dom/') ||
                id.includes('/node_modules/scheduler/')
              ) {
                return 'vendor-react';
              }
              if (
                id.includes('react-markdown') ||
                id.includes('remark-gfm') ||
                id.includes('remark-math') ||
                id.includes('rehype-katex') ||
                id.includes('/node_modules/katex/') ||
                id.includes('micromark') ||
                id.includes('mdast') ||
                id.includes('hast') ||
                id.includes('unist') ||
                id.includes('vfile') ||
                id.includes('unified')
              ) {
                return 'vendor-markdown';
              }
              if (id.includes('/node_modules/lucide-react/')) {
                return 'vendor-icons';
              }
              if (id.includes('/node_modules/pdf-lib/')) {
                return 'vendor-pdf-lib';
              }
              if (id.includes('/node_modules/@e965/xlsx/') || id.includes('/node_modules/cfb/')) {
                return 'vendor-xlsx';
              }
              if (id.includes('/node_modules/mammoth/')) {
                return 'vendor-mammoth';
              }
              if (id.includes('/node_modules/jszip/')) {
                return 'vendor-jszip';
              }
            }
          }
        }
      }
    },
    optimizeDeps: {
      exclude: ['@jsquash/oxipng', '@fe-daily/gifsicle-wasm-browser'],
    },
    resolve: {
      alias: {
        '@': path.resolve('.'),
      },
    },
    server: {
      host: '0.0.0.0',
      port: 3000,
      allowedHosts: true as const,
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
