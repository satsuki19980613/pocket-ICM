/**
 * 3人 事前計算テーブルのブラウザ読み込み（後方互換エイリアス）。
 * 実体は次元非依存の pfLoader.browser.ts（loadPfTableBrowser）。
 */
import { loadPfTableBrowser } from './pfLoader.browser.js';
import type { Pf3wayTable } from './pf3wayTable.js';

export async function loadPf3wayTableBrowser(urls: { meta: string; bin: string }): Promise<Pf3wayTable> {
  return loadPfTableBrowser(urls);
}
