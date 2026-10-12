import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defaultClientConditions } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import { defineConfig } from 'vitest/config';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  // SBD_APP_VERSION: only for the e2e update test, which builds a second copy as "version B".
  define: { __APP_VERSION__: JSON.stringify(process.env['SBD_APP_VERSION'] ?? pkg.version) },
  // Image packaging reads actual bundled modules (including Workbox) from these
  // build-only maps, then removes the maps from the runtime web directory.
  build: { sourcemap: process.env['SBD_IMAGE_LICENSES'] === '1' ? 'hidden' : false },
  // Resolve workspace packages to their TypeScript sources (see the "source" export condition).
  resolve: { conditions: ['source', ...defaultClientConditions] },
  plugins: [
    svelte(),
    VitePWA({
      // "prompt": a new service worker waits until the page tells it to take over, which
      // src/lib/sw-update.ts does at once when nothing is unsaved, else after "Reload".
      // (Before 0.5.2 this said autoUpdate, but with injectRegister: false the worker did not
      // skip waiting while the page waited for it to: new versions never arrived in open tabs.)
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['icon.svg', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'],
      manifest: {
        name: 'Storyboard Viewer',
        short_name: 'Storyboard',
        description: 'View and edit .sbd storyboards, offline.',
        theme_color: '#1b1e24',
        background_color: '#111317',
        display: 'standalone',
        start_url: '.',
        scope: '.',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          {
            src: 'icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
        file_handlers: [{ action: '.', accept: { 'application/vnd.sbd+zip': ['.sbd'] } }] as never,
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webp,woff2}'],
        // The local server's API and media must always hit the network (live refresh, Range).
        navigateFallbackDenylist: [/^\/api\//],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        // Bundled examples ("Try an example") are cached once opened, so they work offline too.
        runtimeCaching: [
          {
            urlPattern: /\/examples\/[^/?]+\.sbd$/,
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'sbd-examples' },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    // `SBD_API=http://localhost:4400 pnpm dev` proxies /api to a running `sbd serve`.
    proxy: process.env['SBD_API'] ? { '/api': process.env['SBD_API'] } : {},
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
