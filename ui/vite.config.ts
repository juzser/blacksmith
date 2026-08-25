import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.join(here, 'src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:4680',
    },
  },
  build: {
    outDir: path.join(here, 'dist'),
    emptyOutDir: true,
  },
});
