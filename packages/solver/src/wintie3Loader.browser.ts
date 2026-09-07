/**
 * 3-way オールイン結果テーブルのブラウザ読み込み（fetch 版, Phase 3 / App）。
 * 同梱の `wintie3-169.meta.json` / `wintie3-169.u16.bin` を静的アセットとして fetch し、
 * `wintie3Table.buildWinTie3Table` で共通型に組む。Node 組み込みに依存しない。
 */

import { buildWinTie3Table, type WinTie3Table } from './wintie3Table.js';

export type { WinTie3Table } from './wintie3Table.js';

/** meta/bin の URL（Vite の `?url` import などで解決したもの）を渡して読み込む。 */
export async function loadWinTie3TableBrowser(urls: { meta: string; bin: string }): Promise<WinTie3Table> {
  const [metaRes, binRes] = await Promise.all([fetch(urls.meta), fetch(urls.bin)]);
  if (!metaRes.ok) throw new Error(`wintie3 meta fetch failed: ${metaRes.status} ${urls.meta}`);
  if (!binRes.ok) throw new Error(`wintie3 bin fetch failed: ${binRes.status} ${urls.bin}`);
  const meta = (await metaRes.json()) as { dims: number; nTriples: number };
  const buf = await binRes.arrayBuffer();
  const u16 = new Uint16Array(buf);
  return buildWinTie3Table(u16, meta);
}
