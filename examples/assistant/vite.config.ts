import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
  // The workspace keeps packages, fonts among them, under ts/node_modules and ts/packages.
  server: { fs: { allow: ['../../ts'] } },
  // flatbed's packages run as TypeScript source on Node 24, and read files beside themselves, such
  // as the supervisor's spec schema, so the server build imports them rather than bundling them.
  build: { rollupOptions: { external: [/^@flatbed\//] } },
});
