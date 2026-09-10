/**
 * アクションマークの語テンプレ生成（dev, 多例）。フォールドを含む 5 語。
 *
 * `genActionTemplates.ts`（能動 4 語・固定座標プロファイルの zone・whiteMask 正規化）の
 * 後継。テンプレは **本番と同じ経路**で切り出す（単一の真実）:
 *   normalizeForAnchors → enumerateSeats（席名 nameBox）→ markZoneRect → locateMarkPlate
 *   → markInkMask（Otsu）→ normMark
 * テンプレと候補の作り方が違うと NCC は成立しないので、ここは src/actionMark.ts を
 * そのまま呼ぶ。
 *
 * 使い方:
 *   npx tsx scripts/genActionMarks.ts [--out assets/action_marks.json] [--dump <dir>]
 * --dump を付けると、切り出したプレート・インクマスク・正規化像を PNG で書き出す
 * （AI 目視で 1 枚ずつ確認するため。[[ocr-accuracy-verification]] の規律）。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng, encodePng, type Raster } from './pngCodec.js';
import { normalizeForAnchors } from '../src/upscaleNormalize.js';
import { enumerateSeats, type Slot } from '../src/seatEnum.js';
import { markZoneRect, pickMarkGrid } from '../src/actionMarkZone.js';
import { locateMarkPlate, markInkMask, normMark } from '../src/actionMark.js';
import type { Rgba } from '../src/color.js';
import type { Gray } from '../src/types.js';

const DIR = 'local-fixtures';
const toRgba = (r: Raster): Rgba => ({ w: r.width, h: r.height, data: r.rgba });

/**
 * [語, ファイル名, 画面席]。すべて AI 目視で実物のプレートを確認済み
 * （既存 GT の action ラベル＋サブエージェントの再照合 2026-09-10）。
 * 席・テーマ・機種の差を多例で吸収する（緑無地卓 / ローズ装飾卓 / iOS を混ぜる）。
 */
const SPECS: readonly [string, string, Slot][] = [
  // --- フォールド（従来テンプレが持っていなかった語）---
  ['フォールド', 'Screenshot_20260901-142820.png', 'TL'],
  ['フォールド', 'Screenshot_20260902-114437.png', 'TL'],
  ['フォールド', 'Screenshot_20260902-114437.png', 'TR'],
  ['フォールド', 'Screenshot_20260902-114437.png', 'BR'],
  ['フォールド', 'Screenshot_20260902-115034.png', 'TR'],
  ['フォールド', 'Screenshot_20260902-114640.png', 'TR'],
  ['フォールド', 'Screenshot_20260902-114640.png', 'BL'],
  ['フォールド', 'Screenshot_20260902-114544.png', 'BR'],
  ['フォールド', 'Screenshot_20260902-114522.png', 'BR'],
  ['フォールド', 'Screenshot_20260902-203304.png', 'TC'], // ローズ装飾卓
  ['フォールド', 'Screenshot_20260902-203304.png', 'TR'],
  ['フォールド', 'Screenshot_20260902-203304.png', 'BR'],
  ['フォールド', 'E4073E5F-9454-480E-AC61-C15E6728DCBD.png', 'TC'], // iOS 実機
  ['フォールド', 'E4073E5F-9454-480E-AC61-C15E6728DCBD.png', 'TR'],
  ['フォールド', 'E4073E5F-9454-480E-AC61-C15E6728DCBD.png', 'BR'],
  ['フォールド', 'EC7CD106-18EC-4D16-8DDB-7FD454071DB5.png', 'BR'],
  // --- レイズ ---
  ['レイズ', 'Screenshot_20260901-142826.png', 'TR'],
  ['レイズ', 'Screenshot_20260901-101510.png', 'TL'],
  ['レイズ', 'Screenshot_20260902-114640.png', 'TL'],
  ['レイズ', 'Screenshot_20260902-114643.png', 'TL'],
  // --- コール ---
  ['コール', 'Screenshot_20260901-101510.png', 'TR'],
  ['コール', 'Screenshot_20260902-115034.png', 'TL'],
  ['コール', 'Screenshot_20260902-115037.png', 'TL'],
  ['コール', 'Screenshot_20260902-124620.png', 'TC'],
  ['コール', 'Screenshot_20260902-114640.png', 'BR'],
  // --- オールイン ---
  ['オールイン', 'Screenshot_20260902-115309.png', 'TR'],
  ['オールイン', 'Screenshot_20260902-115313.png', 'TR'],
  // hero(BC) の実例は意図的に入れない。101510 BC を試したが、hero 席の帯にはマークが入っておらず
  // （チップスタックと緑のフェルトが切り出された）、これをテンプレに入れると hero 席の金枠装飾が
  // 「オールイン」に高信頼で一致し、GT 157 例のうち 30 例で偽陽性を出した（実測）。
  // hero のマーク位置は検証済みの実例が無いので未登録のままにする（対応スポットでは hero は手番＝マーク無し）。
  ['オールイン', 'Screenshot_20260902-123636.png', 'TC'],
  // --- チェック（ポストフロップ。プリフロップ判定には出ないが語の混同を防ぐため入れる）---
  ['チェック', 'Screenshot_20260901-143035.png', 'TR'],
  ['チェック', 'Screenshot_20260901-143035.png', 'TC'],
];

const args = process.argv.slice(2);
const outPath = args.includes('--out') ? args[args.indexOf('--out') + 1]! : 'assets/action_marks.json';
const dumpDir = args.includes('--dump') ? args[args.indexOf('--dump') + 1]! : null;
if (dumpDir) mkdirSync(dumpDir, { recursive: true });

const grayToPng = (g: Gray): Raster => {
  const rgba = new Uint8Array(g.w * g.h * 4);
  for (let i = 0; i < g.w * g.h; i++) {
    const v = g.data[i]!;
    rgba[i * 4] = v; rgba[i * 4 + 1] = v; rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255;
  }
  return { width: g.w, height: g.h, rgba };
};

const cropRgbaToPng = (img: Rgba, r: { x: number; y: number; w: number; h: number }): Raster => {
  const rgba = new Uint8Array(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) {
      const s = ((r.y + y) * img.w + (r.x + x)) * 4;
      const d = (y * r.w + x) * 4;
      rgba[d] = img.data[s] ?? 0; rgba[d + 1] = img.data[s + 1] ?? 0;
      rgba[d + 2] = img.data[s + 2] ?? 0; rgba[d + 3] = 255;
    }
  return { width: r.w, height: r.h, rgba };
};

// 語 → ASCII の別名（Windows コンソールと安全なファイル名のため）。
const ALIAS: Record<string, string> = {
  'フォールド': 'fold', 'レイズ': 'raise', 'コール': 'call', 'オールイン': 'allin', 'チェック': 'check',
};

const templates: { label: string; w: number; h: number; data: number[] }[] = [];
const seen = new Set<string>();
const report: string[] = [];
let okCount = 0;
for (const [word, file, slot] of SPECS) {
  const tag = `${ALIAS[word]} ${file} ${slot}`;
  let img: Rgba;
  try {
    img = toRgba(decodePng(readFileSync(join(DIR, file))));
  } catch {
    console.log(`SKIP  ${tag}: file missing`);
    report.push(`SKIP\t${word}\t${file}\t${slot}\tfile missing`);
    continue;
  }
  const { img: nimg } = normalizeForAnchors(img);
  const enr = enumerateSeats(img);
  const seat = enr.seats.find((s) => s.slot === slot);
  const zone = markZoneRect(nimg, slot, seat?.nameBox, pickMarkGrid(img.w / img.h));
  const plate = locateMarkPlate(nimg, zone);
  if (!plate) {
    console.log(`XX    ${tag}: plate not located`);
    report.push(`XX\t${word}\t${file}\t${slot}\tplate not located`);
    continue;
  }
  const mask = markInkMask(nimg, plate.rect);
  const norm = normMark(mask);
  // 連続リプレイフレームの同じフォールドは正規化後に完全一致する。
  // 完全一致を持っても NCC の弁別力は上がらないのに同析アセットを太らせるので除く。
  const key = `${word}|${norm.w}x${norm.h}|${Array.from(norm.data).join('')}`;
  if (seen.has(key)) {
    console.log(`DUP   ${tag}: identical to an existing exemplar (skipped)`);
    report.push(`DUP	${word}	${file}	${slot}	identical`);
    continue;
  }
  seen.add(key);
  templates.push({ label: word, w: norm.w, h: norm.h, data: Array.from(norm.data) });
  okCount++;
  const line = `OK    ${tag}: plate ${plate.rect.w}x${plate.rect.h} sat ${plate.meanSat.toFixed(1)} -> norm ${norm.w}x${norm.h}`;
  console.log(line);
  report.push(`OK\t${word}\t${file}\t${slot}\tplate=${plate.rect.w}x${plate.rect.h}\tsat=${plate.meanSat.toFixed(1)}\tnorm=${norm.w}x${norm.h}`);
  if (dumpDir) {
    const base = `${ALIAS[word]}_${file.replace(/\.png$/, '')}_${slot}`;
    writeFileSync(join(dumpDir, `${base}_1zone.png`), encodePng(cropRgbaToPng(nimg, zone)));
    writeFileSync(join(dumpDir, `${base}_2plate.png`), encodePng(cropRgbaToPng(nimg, plate.rect)));
    writeFileSync(join(dumpDir, `${base}_3mask.png`), encodePng(grayToPng(mask)));
  }
}

writeFileSync(
  outPath,
  JSON.stringify({
    source: 'dev calibration 2026-09-10: mark plate (Otsu-in-plate), 5 words incl. fold, multi-exemplar',
    templates,
  }),
);
if (dumpDir) writeFileSync(join(dumpDir, '_report.tsv'), report.join('\n') + '\n', 'utf8');
console.log(`\nwrote ${outPath} with ${okCount}/${SPECS.length} exemplars`);
