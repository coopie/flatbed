import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
  // The workspace keeps packages, fonts among them, under ts/node_modules and ts/packages.
  server: { fs: { allow: ['../../ts'] } },
});
