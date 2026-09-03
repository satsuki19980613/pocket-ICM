/**
 * N人 push/fold NN モデルのブラウザ読み込み（fetch 版, 次元非依存）。
 * 同梱の meta.json / model.bin を静的アセットとして fetch し、buildNnTable で組む。
 * Node 組み込みに依存しない（5人/6人 共通）。
 */
import { buildNnTable, type NnMeta, type NnTable } from './nnTable.js';

export async function loadNnTableBrowser(urls: { meta: string; bin: string }): Promise<NnTable> {
  const [metaRes, binRes] = await Promise.all([fetch(urls.meta), fetch(urls.bin)]);
  if (!metaRes.ok) throw new Error(`nn model meta fetch failed: ${metaRes.status} ${urls.meta}`);
  if (!binRes.ok) throw new Error(`nn model bin fetch failed: ${binRes.status} ${urls.bin}`);
  const meta = (await metaRes.json()) as NnMeta;
  const buf = await binRes.arrayBuffer();
  return buildNnTable(meta, buf);
}
