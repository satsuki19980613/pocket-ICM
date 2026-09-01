/**
 * 生成済み HU equity テーブル（artifacts/hu-equity-169.*）の Node 読み込み。
 * ランタイム（ソルバー / スクリプト / テスト）から同梱テーブルを引く薄いラッパ。
 *
 * ブラウザ配布時は `huTableLoader.browser.ts`（fetch 版）を使う。共通の型・ビルダは
 * `huTableCore.ts`。本ファイルは node:fs に依存するためブラウザバンドルには含めない。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHuTable, type LoadedHuTable } from './huTableCore.js';

export type { LoadedHuTable } from './huTableCore.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = join(HERE, '..', 'artifacts');

export function huTableArtifactExists(dir: string = ARTIFACT_DIR): boolean {
  return existsSync(join(dir, 'hu-equity-169.f32.bin')) && existsSync(join(dir, 'hu-equity-169.meta.json'));
}

/** 同梱テーブルを読み込む。存在しなければ例外（`npm run gen:hu-equity` を促す）。 */
export function loadHuTable(dir: string = ARTIFACT_DIR): LoadedHuTable {
  const metaPath = join(dir, 'hu-equity-169.meta.json');
  const binPath = join(dir, 'hu-equity-169.f32.bin');
  if (!existsSync(metaPath) || !existsSync(binPath)) {
    throw new Error(`HU equity artifact not found in ${dir}. Run: npm run gen:hu-equity`);
  }
  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { dims: number; order: string[] };
  const raw = readFileSync(binPath);
  const equity = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  return buildHuTable(meta.order, meta.dims, equity);
}
