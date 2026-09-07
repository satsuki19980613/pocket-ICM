/**
 * 生成済み HU 勝ち/引き分けテーブル（artifacts/hu-wintie-169.*）の Node 読み込み。
 * 2 人ショーダウンの厳密計算（showdownExact.ts）で使う。
 *
 * ブラウザ配布時は `huWinTieLoader.browser.ts`（fetch 版）を使う。共通の型・ビルダは
 * `showdownExact.ts`。本ファイルは node:fs に依存するためブラウザバンドルには含めない。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWinTieTable, type WinTieTable } from './showdownExact.js';

export type { WinTieTable } from './showdownExact.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = join(HERE, '..', 'artifacts');

export function huWinTieArtifactExists(dir: string = ARTIFACT_DIR): boolean {
  return existsSync(join(dir, 'hu-wintie-169.f32.bin')) && existsSync(join(dir, 'hu-wintie-169.meta.json'));
}

/** 同梱テーブルを読み込む。存在しなければ例外（`npm run gen:hu-wintie` を促す）。 */
export function loadHuWinTieTable(dir: string = ARTIFACT_DIR): WinTieTable {
  const metaPath = join(dir, 'hu-wintie-169.meta.json');
  const binPath = join(dir, 'hu-wintie-169.f32.bin');
  if (!existsSync(metaPath) || !existsSync(binPath)) {
    throw new Error(`HU win/tie artifact not found in ${dir}. Run: npm run gen:hu-wintie`);
  }
  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { dims: number; order: string[] };
  const raw = readFileSync(binPath);
  const all = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const n2 = meta.dims * meta.dims;
  if (all.length !== n2 * 2) throw new Error(`hu-wintie size mismatch: ${all.length} != ${n2 * 2}`);
  return buildWinTieTable(meta.order, meta.dims, all.subarray(0, n2), all.subarray(n2, n2 * 2));
}
