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
      includeAssets: ['**/*.bin'],
      manifest: {
        name: 'Black Ops ICM',
        short_name: 'Black Ops ICM',
        description: 'ポーカーチェイス クラブマッチ push/fold ICM 復習ツール',
        theme_color: '#0f1420',
        background_color: '#0f1420',
        display: 'standalone',
        orientation: 'portrait',
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,bin,json,woff2,svg,png}'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
    }),
  ],
  worker: { format: 'es' },
  assetsInclude: ['**/*.bin'],
  server: {
    // モノレポ: solver/artifacts の .bin/.meta を ?url で参照するため上位を許可。
    fs: { allow: ['../..'] },
  },
});
