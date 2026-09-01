/**
 * HU equity テーブルの環境非依存コア（型 + ビルダ）。
 * Node（`huTableLoader.ts`, node:fs で読む）とブラウザ（`huTableLoader.browser.ts`,
 * fetch で読む）の両ローダが、生の {order, dims, Float32Array} からこの共通型を組む。
 * 本モジュールは Node 組み込みに一切依存せず、ブラウザバンドルに安全に含められる。
 */

export interface LoadedHuTable {
  order: string[];
  index: Record<string, number>;
  dims: number;
  equity: Float32Array;
  /** hero クラス vs villain クラスの equity（win+tie/2）。 */
  get(hero: string, villain: string): number;
}

/** 生データ（order, dims, 行優先 Float32Array）から `LoadedHuTable` を組む。 */
export function buildHuTable(order: string[], dims: number, equity: Float32Array): LoadedHuTable {
  if (equity.length !== dims * dims) {
    throw new Error(`HU table size mismatch: ${equity.length} != ${dims * dims}`);
  }
  const index: Record<string, number> = Object.fromEntries(order.map((h, i) => [h, i]));
  return {
    order,
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
