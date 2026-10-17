import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve('.'),
      },
    },
    define: {
      'import.meta.env.VITE_GEMINI_API_KEY': JSON.stringify(
        process.env.VITE_GEMINI_API_KEY || process.env.GEMINI_API_KEY || ''
      ),
      'import.meta.env.VITE_GROQ_API_KEY': JSON.stringify(
        process.env.VITE_GROQ_API_KEY || process.env.GROQ_API_KEY || ''
      ),
      'import.meta.env.VITE_OPENROUTER_API_KEY': JSON.stringify(
        process.env.VITE_OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY || ''
      ),
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
