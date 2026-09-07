/**
 * HU 勝ち/引き分けテーブルのブラウザ読み込み（fetch 版, Phase 3 / App）。
 * 同梱の `hu-wintie-169.meta.json` / `hu-wintie-169.f32.bin` を静的アセットとして
 * fetch し、`showdownExact.buildWinTieTable` で共通型に組む。Node 組み込みに依存しない。
 */

import { buildWinTieTable, type WinTieTable } from './showdownExact.js';

export type { WinTieTable } from './showdownExact.js';

/** meta/bin の URL（Vite の `?url` import などで解決したもの）を渡して読み込む。 */
export async function loadHuWinTieTableBrowser(urls: { meta: string; bin: string }): Promise<WinTieTable> {
  const [metaRes, binRes] = await Promise.all([fetch(urls.meta), fetch(urls.bin)]);
  if (!metaRes.ok) throw new Error(`HU win/tie meta fetch failed: ${metaRes.status} ${urls.meta}`);
  if (!binRes.ok) throw new Error(`HU win/tie bin fetch failed: ${binRes.status} ${urls.bin}`);
  const meta = (await metaRes.json()) as { dims: number; order: string[] };
  const buf = await binRes.arrayBuffer();
  const all = new Float32Array(buf);
  const n2 = meta.dims * meta.dims;
  if (all.length !== n2 * 2) throw new Error(`hu-wintie size mismatch: ${all.length} != ${n2 * 2}`);
  return buildWinTieTable(meta.order, meta.dims, all.subarray(0, n2), all.subarray(n2, n2 * 2));
}
