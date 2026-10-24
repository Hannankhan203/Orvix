import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(() => {
  return {
    plugins: [
      react(),
      tailwindcss(),
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
          globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest,wasm}'],
          maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
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
              urlPattern: /^https:\/\/(huggingface\.co|cdn\.jsdelivr\.net)\/.*(resolve\/main|weights).*/i,
              handler: 'NetworkOnly'
            }
          ]
        },
        devOptions: {
          enabled: false
        }
      })
    ],
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
