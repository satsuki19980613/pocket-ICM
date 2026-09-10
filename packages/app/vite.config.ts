import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// PWA（オフライン・GitHub Pages 配布, SPEC §8/§10）。base は相対にして
// Pages のサブパス配信でも動くようにする。HU テーブル(.bin)は precache 対象に含める。
export default defineConfig({
  base: './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['**/*.bin', 'icon.svg', 'apple-touch-icon.png', 'favicon-32x32.png'],
      manifest: {
        name: 'Black Ops ICM',
        short_name: 'Black Ops ICM',
        description: 'ポーカーチェイス クラブマッチ push/fold ICM 復習ツール',
        lang: 'ja',
        // アプリ面と同じ近黒グラファイト（styles.css の --bg）。スプラッシュもここで塗られる。
        theme_color: '#0c0d0a',
        background_color: '#0c0d0a',
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
        // 新デプロイ時に旧バージョンの precache を確実に破棄する（旧UIが居座らないように）。
        // registerType:'autoUpdate' は skipWaiting/clientsClaim を有効化＝新SWが即座に支配。
        cleanupOutdatedCaches: true,
        // Slumbot 中継（/api/slumbot/*）は Service Worker に一切触らせない。
        // POST なので precache 対象外だが、ナビゲーション fallback で index.html を
        // 返されると通信エラーの原因が分からなくなるため明示的に除外する。
        navigateFallbackDenylist: [/^\/api\//],
        // 4人テーブル(f16, ~11MB)・3-wayオールイン結果テーブル(u16, ~21MB)は precache しない
        // （インストールを重くしない）。初回の4人求解／5〜6人求解で fetch →
        // runtimeCaching(CacheFirst)でキャッシュ＝以後オフライン可。
        // 3人(1.33MB)/HU は従来どおり precache（インストール時からオフライン）。
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
    // モノレポ: solver/artifacts の .bin/.meta を ?url で参照するため上位を許可。
    fs: { allow: ['../..'] },
    // 開発時の Slumbot 中継。本番は Cloudflare Worker（worker/index.ts）が同じ形で受ける。
    // 上流は OPTIONS プリフライトを拒否するため、ブラウザから直接は叩けない。
    proxy: {
      '/api/slumbot': {
        target: 'https://slumbot.com',
        changeOrigin: true,
        secure: true,
        rewrite: (path: string) => path.replace(/^\/api\/slumbot/, '/slumbot/api'),
      },
    },
  },
});
