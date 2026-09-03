/**
 * 3人 push or fold / AOF 事前計算テーブルのブラウザ読み込み（fetch 版）。
 * 同梱の `pf3way.meta.json` / `pf3way.f32.bin` を静的アセットとして fetch し、
 * buildPf3wayTable で参照可能な形に組む。Node 組み込みに依存しない。
 */
import { buildPf3wayTable, type Pf3wayMeta, type Pf3wayTable } from './pf3wayTable.js';

export async function loadPf3wayTableBrowser(urls: { meta: string; bin: string }): Promise<Pf3wayTable> {
  const [metaRes, binRes] = await Promise.all([fetch(urls.meta), fetch(urls.bin)]);
  if (!metaRes.ok) throw new Error(`pf3way meta fetch failed: ${metaRes.status} ${urls.meta}`);
  if (!binRes.ok) throw new Error(`pf3way bin fetch failed: ${binRes.status} ${urls.bin}`);
  const meta = (await metaRes.json()) as Pf3wayMeta;
  const buf = await binRes.arrayBuffer();
  return buildPf3wayTable(meta, new Float32Array(buf));
}
