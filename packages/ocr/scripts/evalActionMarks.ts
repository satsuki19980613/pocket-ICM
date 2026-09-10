/**
 * アクションマーク認識の評価ハーネス（dev）。
 *
 * 正解ラベル（accuracy*.groundtruth.json の seats[].action）を持つ**占有席すべて**
 * （action=none も含む）に対して `recognizeMark` を走らせ、混同行列とゲート内訳を出す。
 * none を必ず含めるのが要点 —— 現行バグは「動いていないのに動いたと読む」偽陽性なので、
 * 偽陽性を数えないと改善したか分からない。
 *
 * 使い方: npx tsx scripts/evalActionMarks.ts [--json out.json] [--templates assets/action_marks.json]
 *         [--frame <name>] [--verbose]
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from './pngCodec.js';
import { normalizeForAnchors } from '../src/upscaleNormalize.js';
import { enumerateSeats, SLOTS, type Slot } from '../src/seatEnum.js';
import { markZoneRect, pickMarkGrid } from '../src/actionMarkZone.js';
import { recognizeMarkDiag } from '../src/actionMark.js';
import { templatesFromJson } from '../src/templates.js';
import type { Rgba } from '../src/color.js';
import type { SeatAction } from '../src/types.js';

const DIR = 'local-fixtures';
const GTS = [
  'scripts/accuracy.groundtruth.json',
  'scripts/accuracy.iphone.groundtruth.json',
  'scripts/accuracy.multidev.groundtruth.json',
];
const ACTIONS: readonly string[] = ['none', 'fold', 'call', 'raise', 'allin', 'check'];

const args = process.argv.slice(2);
const tplPath = args.includes('--templates') ? args[args.indexOf('--templates') + 1]! : 'assets/action_marks.json';
const onlyFrame = args.includes('--frame') ? args[args.indexOf('--frame') + 1]! : null;
const verbose = args.includes('--verbose');
const templates = templatesFromJson(JSON.parse(readFileSync(tplPath, 'utf8')));

interface Case {
  frame: string;
  band: string;
  slot: Slot;
  hero: boolean;
  truth: string;
  got: SeatAction;
  conf: number;
  label: string;
  rawConf: number;
  ink: number;
  sat: number | null;
  rejected: string;
}

const cases: Case[] = [];
for (const gt of GTS) {
  const frames = JSON.parse(readFileSync(gt, 'utf8')).frames as Record<
    string,
    { seats?: Record<string, { occ?: string; action?: string; hero?: boolean }> }
  >;
  for (const [name, fr] of Object.entries(frames)) {
    if (onlyFrame && name !== onlyFrame) continue;
    const p = join(DIR, name);
    if (!existsSync(p)) continue;
    const dec = decodePng(readFileSync(p));
    const img: Rgba = { w: dec.width, h: dec.height, data: dec.rgba };
    const { img: nimg } = normalizeForAnchors(img);
    const enr = enumerateSeats(img);
    const grid = pickMarkGrid(img.w / img.h);
    for (const slot of SLOTS) {
      const s = fr.seats?.[slot];
      if (!s || s.occ !== 'occupied') continue;
      const seat = enr.seats.find((q) => q.slot === slot);
      const zone = markZoneRect(nimg, slot, seat?.nameBox, grid);
      const { read, diag } = recognizeMarkDiag(nimg, zone, templates);
      cases.push({
        frame: name,
        band: `${dec.width}x${dec.height}`,
        slot,
        hero: s.hero === true,
        truth: s.action ?? 'none',
        got: read.value,
        conf: read.conf,
        label: diag.label,
        rawConf: diag.rawConf,
        ink: diag.ink,
        sat: diag.plate ? diag.plate.meanSat : null,
        rejected: diag.rejected ?? '',
      });
    }
  }
}

// --- 混同行列 ---
const conf: Record<string, Record<string, number>> = {};
for (const t of ACTIONS) { conf[t] = {}; for (const g of ACTIONS) conf[t]![g] = 0; }
for (const c of cases) {
  conf[c.truth] ??= {};
  conf[c.truth]![c.got] = (conf[c.truth]![c.got] ?? 0) + 1;
}
const pad = (s: string, n: number) => s.padEnd(n);
console.log(`templates: ${tplPath} (${templates.length})   cases: ${cases.length}`);
console.log('\n=== confusion (rows = truth, cols = OCR) ===');
console.log(pad('truth', 8) + ACTIONS.map((a) => pad(a, 7)).join('') + ' total');
for (const t of ACTIONS) {
  const row = conf[t] ?? {};
  const total = ACTIONS.reduce((n, g) => n + (row[g] ?? 0), 0);
  if (total === 0) continue;
  console.log(pad(t, 8) + ACTIONS.map((g) => pad(String(row[g] ?? 0), 7)).join('') + ' ' + total);
}
const ok = cases.filter((c) => c.truth === c.got).length;
console.log(`\naccuracy: ${ok}/${cases.length} (${((100 * ok) / Math.max(1, cases.length)).toFixed(1)}%)`);

console.log('\n=== mismatches ===');
for (const c of cases.filter((q) => q.truth !== q.got)) {
  console.log(
    `  ${pad(c.frame, 42)} ${c.slot}${c.hero ? '*' : ' '} truth=${pad(c.truth, 6)} got=${pad(c.got, 6)}` +
      ` label=${pad(c.label || '-', 6)} rawConf=${c.rawConf.toFixed(3)} ink=${c.ink.toFixed(3)}` +
      ` sat=${c.sat === null ? '  -  ' : c.sat.toFixed(1)} rej=${c.rejected || '-'}`,
  );
}

// --- ゲートの効き（none が何で落ちたか） ---
const rejCount: Record<string, number> = {};
for (const c of cases.filter((q) => q.truth === 'none')) rejCount[c.rejected || 'accepted'] = (rejCount[c.rejected || 'accepted'] ?? 0) + 1;
console.log('\n=== truth=none がどのゲートで落ちたか ===');
for (const [k, v] of Object.entries(rejCount).sort((a, b) => b[1] - a[1])) console.log(`  ${pad(k, 10)} ${v}`);

// --- 彩度の分布（fold vs 能動）---
const sats = (pred: (c: Case) => boolean) =>
  cases.filter((c) => pred(c) && c.sat !== null).map((c) => c.sat!);
const rng = (xs: number[]) => (xs.length ? `${Math.min(...xs).toFixed(1)}-${Math.max(...xs).toFixed(1)} (n=${xs.length})` : 'n=0');
console.log('\n=== plate meanSat ===');
console.log(`  truth=fold          : ${rng(sats((c) => c.truth === 'fold'))}`);
console.log(`  truth=call/raise/allin/check: ${rng(sats((c) => ['call', 'raise', 'allin', 'check'].includes(c.truth)))}`);
console.log(`  truth=none          : ${rng(sats((c) => c.truth === 'none'))}`);

if (verbose) {
  console.log('\n=== all cases ===');
  for (const c of cases) {
    console.log(
      `  ${pad(c.frame, 42)} ${c.slot}${c.hero ? '*' : ' '} truth=${pad(c.truth, 6)} got=${pad(c.got, 6)}` +
        ` label=${pad(c.label || '-', 6)} rawConf=${c.rawConf.toFixed(3)} ink=${c.ink.toFixed(3)}` +
        ` sat=${c.sat === null ? '  -  ' : c.sat.toFixed(1)} rej=${c.rejected || '-'}`,
    );
  }
}

const outIdx = args.indexOf('--json');
if (outIdx >= 0) {
  writeFileSync(args[outIdx + 1]!, JSON.stringify({ cases, conf }, null, 2), 'utf8');
  console.log(`\n(JSON: ${args[outIdx + 1]})`);
}
