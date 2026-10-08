import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * ローカル版（ICM 読み取り専用）のビルド設定。
 *
 *   開発:   npm run dev:local     （PC と同じ Wi-Fi の iPhone からも開ける: --host）
 *   ビルド: npm run build:local   → packages/app/dist-local/
 *
 * 本体（vite.config.ts）と同じソース・同じテーブルを使い、エントリだけ local/index.html に替える。
 * Supabase・Slumbot 中継・SIT & GO は読み込まない。静的ファイルだけで完結するので、
 * dist-local を HTTPS の静的ホスティングに置けば iPhone で「ホーム画面に追加」→オフライン起動できる。
 */
export default defineConfig({
  root: 'local',
  base: './',
  publicDir: '../public',
  build: {
    outDir: '../dist-local',
    emptyOutDir: true,
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: false,
      includeAssets: ['**/*.bin', 'icon.svg', 'apple-touch-icon.png', 'favicon-32x32.png'],
      manifest: {
        name: 'ICM Local',
        short_name: 'ICM Local',
        description: 'ポーカーチェイス push/fold ICM 読み取り（ローカル版・端末内で完結）',
        lang: 'ja',
        theme_color: '#000000',
        background_color: '#000000',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,bin,json,woff2,svg,png}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        // 大きい表（4人 f16 ~11MB / 3-way オールイン u16 ~21MB）は初回使用時に取得してキャッシュ。
        globIgnores: ['**/pf4way.f16-*.bin', '**/wintie3-169.u16-*.bin'],
        runtimeCaching: [
          {
            urlPattern: /pf4way\.f16-.*\.bin$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'pf4way-table',
              expiration: { maxEntries: 2 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /wintie3-169\.u16-.*\.bin$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'wintie3-table',
              expiration: { maxEntries: 2 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
  worker: { format: 'es' },
  assetsInclude: ['**/*.bin'],
  server: {
    fs: { allow: ['../..'] },
  },
  preview: {
    port: 4174,
  },
});
