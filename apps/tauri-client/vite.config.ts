import { defineConfig } from 'vite';

// The Tauri client's frontend dev server. Pinned to 1420 to match
// `devUrl` in src-tauri/tauri.conf.json and to avoid colliding with the
// hub-server dev server (Vite default 5173). strictPort fails fast rather
// than silently picking another port that Tauri would then wait on forever.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
});
