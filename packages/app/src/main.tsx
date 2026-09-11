import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initAppUpdate } from './pwa/appUpdate';
import { versionFromBundleUrl } from './pwa/updatePolicy';
import './styles.css';

// 新しい版の配信を拾って入れ替える（起動直後は自動・使用中はお知らせ）。描画より先に始める。
// import.meta.url はこのファイルが入るエントリのバンドル（assets/index-<ハッシュ>.js）を指す。
initAppUpdate(versionFromBundleUrl(import.meta.url));

const el = document.getElementById('root');
if (!el) throw new Error('root element not found');
createRoot(el).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
