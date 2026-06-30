import mdx from '@mdx-js/rollup';
import { honoPreact } from 'hono-preact/vite';
import { nodeAdapter } from 'hono-preact/adapter-node';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';

function pipelinePlugin(): Plugin {
  return {
    name: 'hub-pipeline',
    configureServer(server) {
      import('./src/server-init.js').then(m => m.startPipeline()).catch(console.error);
      server.httpServer?.once('listening', () => {
        const addr = server.httpServer?.address();
        const { address, port } = typeof addr === 'object' && addr ? addr : { address: 'localhost', port: '?' };
        const host = address === '::' || address === '0.0.0.0' ? 'localhost' : address;
        console.log(`[hub] Listening on http://${host}:${port}`);
      });
    },
  };
}

export default defineConfig({
  plugins: [mdx({ jsxImportSource: 'preact' }), honoPreact({ adapter: nodeAdapter() }), pipelinePlugin()],
  ssr: {
    // hono-preact uses import.meta.env.PROD which requires Vite's transform
    // pipeline. Without this, the SSR module runner loads it via Node native
    // ESM where import.meta.env is undefined, crashing ClientScript on render.
    noExternal: ['hono-preact'],
  },
});
