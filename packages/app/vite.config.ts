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
      // 更新は prompt 方式: 新しい版の SW は「待機」で止め、入れ替える時機はアプリ側
      // （src/pwa/appUpdate.ts）が決める＝起動直後・復帰直後は自動、使用中はお知らせ。
      // autoUpdate（即 skipWaiting）だと、開いている古い画面の下で SW だけが入れ替わって
      // 旧ハッシュのファイルが消える上、画面は開き直すまで古いままだった。
      registerType: 'prompt',
      // 登録は appUpdate.ts が virtual:pwa-register で行う（registerSW.js の自動挿入はしない）。
      injectRegister: false,
      includeAssets: ['**/*.bin', 'icon.svg', 'apple-touch-icon.png', 'favicon-32x32.png'],
      manifest: {
        name: 'Black Ops ICM',
        short_name: 'Black Ops ICM',
        description: 'ポーカーチェイス クラブマッチ push/fold ICM 復習ツール',
        lang: 'ja',
        // 背景と同じ完全な黒（styles.css の --bg2）。ステータスバーとスプラッシュもここで塗られる。
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
        // 新デプロイ時に旧バージョンの precache を確実に破棄する（旧UIが居座らないように）。
        cleanupOutdatedCaches: true,
        // 初回インストールはその場でページを支配する（初回の4人求解などのテーブル取得も
        // キャッシュさせるため。autoUpdate 時代と同じ）。更新時は待機のまま、アプリが
        // SKIP_WAITING を送った時点で入れ替わる（prompt 方式なので skipWaiting は付かない）。
        clientsClaim: true,
        // Slumbot 中継（/api/slumbot/*）は Service Worker に一切触らせない。
        // POST なので precache 対象外だが、ナビゲーション fallback で index.html を
        // 返されると通信エラーの原因が分からなくなるため明示的に除外する。
        navigateFallbackDenylist: [/^\/api\//],
        // 4人テーブル(f16, ~11MB)・3-wayオールイン結果テーブル(u16, ~21MB)は precache しない
        // （インストールを重くしない）。初回の4人求解／5〜6人求解で fetch →
        // runtimeCaching(CacheFirst)でキャッシュ＝以後オフライン可。
        // 3人(1.33MB)/HU は従来どおり precache（インストール時からオフライン）。
        // 管理者だけの画面（adminScreens-*.js・App が lazy で読む）も precache しない＝管理者以外の端末には
        // ダウンロードされない（管理者が開いたときだけネットから読む）。
        globIgnores: ['**/pf4way.f16-*.bin', '**/wintie3-169.u16-*.bin', '**/adminScreens-*.js'],
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
