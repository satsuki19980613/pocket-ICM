/**
 * N-way 事前計算テーブルのブラウザ読み込み（fetch 版, 次元非依存）。
 * 同梱の meta.json / f32.bin を静的アセットとして fetch し、buildPfTable で組む。
 * Node 組み込みに依存しない（3人/4人/…共通）。
 */
import { buildPfTable, type PfMeta, type PfTable } from './pfTable.js';

export async function loadPfTableBrowser(urls: { meta: string; bin: string }): Promise<PfTable> {
  const [metaRes, binRes] = await Promise.all([fetch(urls.meta), fetch(urls.bin)]);
  if (!metaRes.ok) throw new Error(`pf table meta fetch failed: ${metaRes.status} ${urls.meta}`);
  if (!binRes.ok) throw new Error(`pf table bin fetch failed: ${binRes.status} ${urls.bin}`);
  const meta = (await metaRes.json()) as PfMeta;
  const buf = await binRes.arrayBuffer();
  return buildPfTable(meta, new Float32Array(buf));
}
