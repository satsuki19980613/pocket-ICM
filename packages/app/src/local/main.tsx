import React from 'react';
import { createRoot } from 'react-dom/client';
import { LocalApp } from './LocalApp';
import { initAppUpdate } from '../pwa/appUpdate';
import { versionFromBundleUrl } from '../pwa/updatePolicy';
import '../styles.css';

// ローカル版のエントリ。ログイン・診断ログ送信は無し（Supabase を一切読み込まない）。
const version = versionFromBundleUrl(import.meta.url);
initAppUpdate(version);

const el = document.getElementById('root');
if (!el) throw new Error('root element not found');
createRoot(el).render(
  <React.StrictMode>
    <LocalApp />
  </React.StrictMode>,
);
