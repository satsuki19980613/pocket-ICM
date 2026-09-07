/**
 * 生成済み 3-way オールイン結果テーブル（artifacts/wintie3-169.*）の Node 読み込み。
 * 3 人ショーダウンの厳密計算（showdownExact.ts の computeShowdown3Exact）で使う。
 *
 * ブラウザ配布時は `wintie3Loader.browser.ts`（fetch 版）を使う。共通の型・ビルダは
 * `wintie3Table.ts`。本ファイルは node:fs に依存するためブラウザバンドルには含めない。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWinTie3Table, type WinTie3Table } from './wintie3Table.js';

export type { WinTie3Table } from './wintie3Table.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = join(HERE, '..', 'artifacts');

export function winTie3ArtifactExists(dir: string = ARTIFACT_DIR): boolean {
  return existsSync(join(dir, 'wintie3-169.u16.bin')) && existsSync(join(dir, 'wintie3-169.meta.json'));
}

/**
 * 同梱テーブルを読み込む。存在しなければ例外
 * （`node --import tsx packages/solver/scripts/gen3wayOutcomeTable.ts` を促す）。
 */
export function loadWinTie3Table(dir: string = ARTIFACT_DIR): WinTie3Table {
  const metaPath = join(dir, 'wintie3-169.meta.json');
  const binPath = join(dir, 'wintie3-169.u16.bin');
  if (!existsSync(metaPath) || !existsSync(binPath)) {
    throw new Error(
      `3-way win/tie artifact not found in ${dir}. Run: node --import tsx packages/solver/scripts/gen3wayOutcomeTable.ts`,
    );
  }
  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { dims: number; nTriples: number };
  const raw = readFileSync(binPath);
  const u16 = new Uint16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
  return buildWinTie3Table(u16, meta);
}
