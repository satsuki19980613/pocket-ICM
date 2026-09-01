/**
 * 生成済み HU equity テーブル（artifacts/hu-equity-169.*）の読み込み。
 * ランタイム（ソルバー / アプリ）から同梱テーブルを引くための薄いラッパ。
 *
 * Node 環境ではファイルから読む。ブラウザ配布時は bundler で bin/meta を
 * 取り込む想定だが、その配線は App フェーズ（Phase 3）で行う。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = join(HERE, '..', 'artifacts');

export interface LoadedHuTable {
  order: string[];
  index: Record<string, number>;
  dims: number;
  equity: Float32Array;
  /** hero クラス vs villain クラスの equity（win+tie/2）。 */
  get(hero: string, villain: string): number;
}

export function huTableArtifactExists(dir: string = ARTIFACT_DIR): boolean {
  return existsSync(join(dir, 'hu-equity-169.f32.bin')) && existsSync(join(dir, 'hu-equity-169.meta.json'));
}

/** 同梱テーブルを読み込む。存在しなければ例外（`npm run gen:hu-equity` を促す）。 */
export function loadHuTable(dir: string = ARTIFACT_DIR): LoadedHuTable {
  const metaPath = join(dir, 'hu-equity-169.meta.json');
  const binPath = join(dir, 'hu-equity-169.f32.bin');
  if (!existsSync(metaPath) || !existsSync(binPath)) {
    throw new Error(
      `HU equity artifact not found in ${dir}. Run: npm run gen:hu-equity`,
    );
  }
  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { dims: number; order: string[] };
  const raw = readFileSync(binPath);
  const equity = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const dims = meta.dims;
  if (equity.length !== dims * dims) {
    throw new Error(`artifact size mismatch: ${equity.length} != ${dims * dims}`);
  }
  const index: Record<string, number> = Object.fromEntries(meta.order.map((h, i) => [h, i]));

  return {
    order: meta.order,
    index,
    dims,
    equity,
    get(hero: string, villain: string): number {
      const i = index[hero];
      const j = index[villain];
      if (i === undefined || j === undefined) throw new Error(`unknown class: ${hero} / ${villain}`);
      return equity[i * dims + j]!;
    },
  };
}
