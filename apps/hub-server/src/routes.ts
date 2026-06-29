import { defineRoutes, contentRoutes } from 'hono-preact';
import DocsLayout from './docs/DocsLayout.js';

export default defineRoutes([
  {
    path: '/',
    view: () => import('./pages/home.js'),
    server: () => import('./pages/home.server.js'),
  },
  { path: '/about', view: () => import('./pages/about.js') },
  {
    path: '/docs',
    layout: () => import('./docs/DocsLayout.js'),
    children: [
      ...contentRoutes(import.meta.glob('./docs/**/*.mdx'), { wrapper: DocsLayout }),
    ],
  },
]);
