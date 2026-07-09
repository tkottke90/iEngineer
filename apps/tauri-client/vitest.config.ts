import { defineConfig } from 'vitest/config';
import preact from '@preact/preset-vite';

// M10 T009/E3: Vitest bootstrap for the Tauri client frontend. Constitution VI
// names mocha+chai only for packages/types and packages/ui; the app frontend
// uses Vitest (JSDOM) so component tests share the app's Vite/Preact pipeline.
export default defineConfig({
  plugins: [preact()],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
