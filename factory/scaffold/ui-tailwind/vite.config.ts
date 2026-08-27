// Overwrites factory/scaffold/ui/vite.config.ts when the operator answered
// `styling: tailwind` (factory/policies/stack.yml). Identical to the plain
// one but for the plugin — kept as a whole file rather than a patch because
// `copyTemplateDir` layers files, and a config assembled from fragments is a
// config nobody can read in one place.
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
  build: {
    outDir: path.join(here, 'dist'),
    emptyOutDir: true,
  },
});
