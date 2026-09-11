// 管理者だけが使う画面（クラブ管理・診断ログ）。App から lazy で読み込み、1つのチャンク
// （assets/adminScreens-<ハッシュ>.js）にまとめる。PWA の precache から外している（vite.config.ts）ので、
// 管理者以外の端末にはダウンロードされない。データの守りはサーバ側（RLS・管理者専用の関数）が本体。
export { Admin } from './components/Admin';
export { Diagnostics } from './components/Diagnostics';
