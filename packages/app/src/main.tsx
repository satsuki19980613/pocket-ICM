import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initAppUpdate } from './pwa/appUpdate';
import { versionFromBundleUrl } from './pwa/updatePolicy';
import { installGlobalErrorReporting } from './supabase/clientErrors';
import './styles.css';

// import.meta.url はこのファイルが入るエントリのバンドル（assets/index-<ハッシュ>.js）を指す。
const version = versionFromBundleUrl(import.meta.url);

// 新しい版の配信を拾って入れ替える（起動直後は自動・使用中はお知らせ）。描画より先に始める。
initAppUpdate(version);

// どこにも受け止められなかったエラーを管理者の診断ログへ送る（送るのはエラーの文面・画面名・端末の種類だけ）。
installGlobalErrorReporting(version);

const el = document.getElementById('root');
if (!el) throw new Error('root element not found');
createRoot(el).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
