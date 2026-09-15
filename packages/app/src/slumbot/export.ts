/**
 * ハンド履歴を tenfour_watcher 形式の ZIP にして渡す（SPEC §7.4.6）。
 *
 * 端末（Android / iOS）では Web Share でファイルを共有（OneDrive / Drive / LINE 等へ）、
 * 共有できない環境（PC のブラウザ）ではダウンロードに落とす。
 * 受け取った側は ZIP を `data/tenfour_hands/` に展開して `python -m src.db reindex`。
 */

import type { HuHandRecord } from './history';
import { tenfourFileName, tenfourFolder, toTenfourHand } from './tenfour';
import { buildZip, type ZipEntry } from './zip';

export type ExportOutcome = 'shared' | 'downloaded' | 'empty' | 'cancelled';

/** ZIP の中身（純関数・テスト対象）。日付フォルダに 1 ハンド 1 JSON。 */
export function tenfourEntries(recs: readonly HuHandRecord[], heroName: string, now: number = Date.now()): ZipEntry[] {
  const out: ZipEntry[] = [];
  for (const r of recs) {
    const h = toTenfourHand(r, heroName, now);
    if (!h) continue;
    out.push({
      name: `slumbot/${tenfourFolder(r)}/${tenfourFileName(r)}`,
      data: JSON.stringify(h, null, 2),
      mtime: new Date(r.playedAt),
    });
  }
  return out;
}

export function exportFileName(now: number = Date.now()): string {
  const d = new Date(now);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `slumbot_hands_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}.zip`;
}

/** ブラウザ専用のグルー。共有 → ダウンロードの順に試す。 */
export async function exportHands(recs: readonly HuHandRecord[], heroName: string): Promise<ExportOutcome> {
  const entries = tenfourEntries(recs, heroName);
  if (entries.length === 0) return 'empty';
  const bytes = buildZip(entries);
  const name = exportFileName();
  // buildZip は自前の ArrayBuffer を持つ Uint8Array を返す（SharedArrayBuffer ではない）。
  const file = new File([bytes.buffer as ArrayBuffer], name, { type: 'application/zip' });

  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (typeof nav.share === 'function' && typeof nav.canShare === 'function' && nav.canShare({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: 'Slumbot HU ハンド履歴' });
      return 'shared';
    } catch (e) {
      // 共有シートを閉じただけなら何もしない。それ以外はダウンロードに倒す。
      if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled';
    }
  }

  const url = URL.createObjectURL(file);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
  return 'downloaded';
}
