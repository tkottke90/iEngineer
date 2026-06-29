import mdx from '@mdx-js/rollup';
import { honoPreact } from 'hono-preact/vite';
import { nodeAdapter } from 'hono-preact/adapter-node';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [mdx({ jsxImportSource: 'preact' }), honoPreact({ adapter: nodeAdapter() })],
  ssr: {
    // hono-preact uses import.meta.env.PROD which requires Vite's transform
    // pipeline. Without this, the SSR module runner loads it via Node native
    // ESM where import.meta.env is undefined, crashing ClientScript on render.
    noExternal: ['hono-preact'],
  },
});
