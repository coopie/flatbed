import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

const shim = (name: string) => fileURLToPath(new URL(`./src/shims/${name}.ts`, import.meta.url));

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    // The packages' main entries still import Node modules for their file stores, which the page
    // never calls. These stand-ins let them load in a browser until docs/kickoffs/docs-folders.md
    // makes the entries browser-safe; then this block goes.
    alias: {
      'node:fs/promises': shim('fs-promises'),
      'node:fs': shim('fs'),
      'node:path': shim('path'),
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
});
