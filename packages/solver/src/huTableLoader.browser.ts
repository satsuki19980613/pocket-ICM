/**
 * HU equity テーブルのブラウザ読み込み（fetch 版, Phase 3 / App）。
 * 同梱の `hu-equity-169.meta.json` / `hu-equity-169.f32.bin` を静的アセットとして
 * fetch し、`huTableCore.buildHuTable` で共通型に組む。Node 組み込みに依存しない。
 */

import { buildHuTable, type LoadedHuTable } from './huTableCore.js';

export type { LoadedHuTable } from './huTableCore.js';

/** meta/bin の URL（Vite の `?url` import などで解決したもの）を渡して読み込む。 */
export async function loadHuTableBrowser(urls: { meta: string; bin: string }): Promise<LoadedHuTable> {
  const [metaRes, binRes] = await Promise.all([fetch(urls.meta), fetch(urls.bin)]);
  if (!metaRes.ok) throw new Error(`HU meta fetch failed: ${metaRes.status} ${urls.meta}`);
  if (!binRes.ok) throw new Error(`HU bin fetch failed: ${binRes.status} ${urls.bin}`);
  const meta = (await metaRes.json()) as { dims: number; order: string[] };
  const buf = await binRes.arrayBuffer();
  const equity = new Float32Array(buf);
  return buildHuTable(meta.order, meta.dims, equity);
}
