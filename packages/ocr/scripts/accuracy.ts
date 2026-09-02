/**
 * 全体精度検証ハーネス（dev 専用, Plan 2-3 / 指標化）。
 *
 * 正解ラベル付き（AI 目視 = accuracy.groundtruth.json）の有効/対象外プリフロップ局面に対し、
 * 製品コードの end-to-end（decodePng → extractRawReads(CHIPS_6MAX) → runOcrPipeline）を実行し、
 * フィールド別・フレーム別の **達成率** を出す。テンプレは assets/（アプリ同梱の確定版）。
 *
 * 完了条件は「テストが通った」ではなく「AI 目視 vs OCR で N/N」を数値で示すこと
 * （[[ocr-accuracy-verification]]）。画像は local-fixtures/（gitignore）にある物だけ採点し、
 * 無ければ skip（ラベル JSON はコミットして仕様として残す）。
 *
 * 使い方: npx tsx scripts/accuracy.ts [--json out.json] [--frame <name>]
 */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { decodePng } from './pngCodec.js';
import { extractRawReads, type ExtractTemplates } from '../src/extract.js';
import { CHIPS_6MAX } from '../src/frameProfile.js';
import { runOcrPipeline, type OcrValidation } from '../src/pipeline.js';
import { templatesFromJson } from '../src/templates.js';
import type { RawReads } from '../src/types.js';
import type { Rgba } from '../src/color.js';

// ---- テンプレ（アプリ同梱の確定版 = assets/）----
const A = 'assets';
const load = (p: string) => templatesFromJson(JSON.parse(readFileSync(p, 'utf8')));
const templates: ExtractTemplates = {
  digits: load(`${A}/digits.json`),
  ranks: load(`${A}/ranks_hero.json`),
  actions: load(`${A}/actions.json`),
  letters: load(`${A}/letters_bb.json`),
};

// ---- 正解ラベル ----
const DIR = 'local-fixtures';
const GT = JSON.parse(readFileSync('scripts/accuracy.groundtruth.json', 'utf8')) as {
  frames: Record<string, GtFrame>;
};
type SeatId = 'TL' | 'TC' | 'TR' | 'BR' | 'BC' | 'BL';
interface GtSeat {
  occ: 'occupied' | 'empty';
  action?: string;
  stack?: number;
  bet?: number;
  hero?: boolean;
  button?: boolean;
}
interface GtFrame {
  note?: string;
  displayMode: 'bb' | 'chips';
  blinds: { sb: number; bb: number };
  ante: number;
  pot: number;
  heroHand: string;
  seats: Record<SeatId, GtSeat>;
  expect: { ok: boolean; heroPos?: string; playersLeft?: number; reasonHint?: string };
}

// ---- 採点ユーティリティ ----
const argv = process.argv.slice(2);
const only = argv.includes('--frame') ? argv[argv.indexOf('--frame') + 1] : undefined;
const jsonOut = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : undefined;

const TOL = { amount: 0.05, ante: 0.03, pot: 0.15 };
const near = (a: number, b: number, tol: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;

interface Counter { ok: number; total: number; }
const bump = (c: Counter, good: boolean) => { c.total++; if (good) c.ok++; };
const rate = (c: Counter) => (c.total === 0 ? '  n/a' : `${((100 * c.ok) / c.total).toFixed(1).padStart(5)}%`);

const cats = ['displayMode', 'blinds', 'ante', 'pot', 'heroHand', 'occupancy', 'action', 'stack', 'bet', 'verdict', 'heroPos', 'playersLeft'] as const;
type Cat = (typeof cats)[number];
const field: Record<Cat, Counter> = Object.fromEntries(cats.map((c) => [c, { ok: 0, total: 0 }])) as Record<Cat, Counter>;

interface FrameResult {
  frame: string;
  present: boolean;
  displayModeTruth: string;
  read: Counter; // このフレームの read フィールド一致数
  verdictOk: boolean;
  discrepancies: string[];
  ms: number;
}
const results: FrameResult[] = [];

for (const [frame, gt] of Object.entries(GT.frames)) {
  if (only && frame !== only) continue;
  const path = `${DIR}/${frame}`;
  if (!existsSync(path)) {
    results.push({ frame, present: false, displayModeTruth: gt.displayMode, read: { ok: 0, total: 0 }, verdictOk: false, discrepancies: ['(画像なし=skip)'], ms: 0 });
    continue;
  }
  const t0 = Date.now();
  const img = decodePng(readFileSync(path));
  const rgba: Rgba = { w: img.width, h: img.height, data: img.rgba };
  const reads: RawReads = extractRawReads(rgba, CHIPS_6MAX, templates, { betMinCh: 125 });
  const res: OcrValidation = runOcrPipeline(reads);
  const ms = Date.now() - t0;

  const disc: string[] = [];
  const fr: Counter = { ok: 0, total: 0 };
  const score = (cat: Cat, good: boolean, label: string, truth: unknown, got: unknown) => {
    bump(field[cat], good);
    bump(fr, good);
    if (!good) disc.push(`${label}: 期待=${truth} / OCR=${got}`);
  };

  // フレーム全体フィールド
  score('displayMode', reads.displayMode === gt.displayMode, 'displayMode', gt.displayMode, reads.displayMode);
  score('blinds', near(reads.blinds.sb.value, gt.blinds.sb, TOL.amount) && near(reads.blinds.bb.value, gt.blinds.bb, TOL.amount), 'blinds', `${gt.blinds.sb}/${gt.blinds.bb}`, `${reads.blinds.sb.value}/${reads.blinds.bb.value}`);
  score('ante', near(reads.ante.amount.value, gt.ante, TOL.ante), 'ante', gt.ante, reads.ante.amount.value.toFixed?.(4));
  score('pot', near(reads.pot.value, gt.pot, TOL.pot), 'pot', gt.pot, reads.pot.value);
  score('heroHand', reads.heroHand.value === gt.heroHand, 'heroHand', gt.heroHand, reads.heroHand.value);

  // 席別
  const bySeat = new Map(reads.seats.map((s) => [s.id as SeatId, s]));
  for (const id of ['TL', 'TC', 'TR', 'BR', 'BC', 'BL'] as SeatId[]) {
    const g = gt.seats[id];
    const s = bySeat.get(id);
    if (!g || !s) continue;
    score('occupancy', s.occupancy.value === g.occ, `${id}.occ`, g.occ, s.occupancy.value);
    if (g.occ === 'occupied') {
      score('action', s.action.value === (g.action ?? 'none'), `${id}.action`, g.action ?? 'none', s.action.value);
      if (g.stack !== undefined) score('stack', near(s.stack.value, g.stack, TOL.amount), `${id}.stack`, g.stack, s.stack.value);
      if (g.bet !== undefined) score('bet', near(s.bet.value, g.bet, TOL.amount), `${id}.bet`, g.bet, s.bet.value);
    }
  }

  // 判定（対象外は棄却が正解）
  const verdictGood = res.ok === gt.expect.ok;
  score('verdict', verdictGood, 'verdict(ok)', gt.expect.ok, res.ok);
  if (gt.expect.ok) {
    // 有効局面のみ heroPos / playersLeft を採点
    score('heroPos', !!res.state && res.state.heroPos === gt.expect.heroPos, 'heroPos', gt.expect.heroPos, res.state?.heroPos ?? '(棄却)');
    score('playersLeft', !!res.state && res.state.playersLeft === gt.expect.playersLeft, 'playersLeft', gt.expect.playersLeft, res.state?.playersLeft ?? '(棄却)');
  }

  results.push({ frame, present: true, displayModeTruth: gt.displayMode, read: fr, verdictOk: verdictGood, discrepancies: disc, ms });
}

// ---- 出力 ----
const scored = results.filter((r) => r.present);
const skipped = results.filter((r) => !r.present);
const frameFull = scored.filter((r) => r.read.ok === r.read.total).length;

// 有効/対象外の別
const validTruth = Object.entries(GT.frames).filter(([f, g]) => g.expect.ok && scored.some((r) => r.frame === f));
const rejectTruth = Object.entries(GT.frames).filter(([f, g]) => !g.expect.ok && scored.some((r) => r.frame === f));
const rByName = new Map(scored.map((r) => [r.frame, r]));

console.log('\n===== 全体精度検証（AI 目視ラベル vs OCR end-to-end） =====');
console.log(`採点フレーム: ${scored.length}（有効=${validTruth.length} / 対象外=${rejectTruth.length}）  skip(画像なし): ${skipped.length}`);

console.log('\n--- フィールド別 達成率 ---');
for (const c of cats) console.log(`  ${c.padEnd(12)} ${rate(field[c])}  (${field[c].ok}/${field[c].total})`);

console.log('\n--- フレーム別 ---');
console.log('  frame                            mode  判定  read一致   所要');
for (const r of scored) {
  const v = r.verdictOk ? ' ○ ' : ' × ';
  console.log(`  ${r.frame.replace('Screenshot_', '').padEnd(30)} ${r.displayModeTruth.padEnd(5)} ${v}  ${String(r.read.ok).padStart(2)}/${String(r.read.total).padStart(2)}    ${r.ms}ms`);
}
for (const r of skipped) console.log(`  ${r.frame.replace('Screenshot_', '').padEnd(30)} ${r.displayModeTruth.padEnd(5)}  --   (画像なし)`);

console.log('\n--- サマリ ---');
const verdictC = field['verdict'];
console.log(`  判定（有効/対象外の分類）正解:   ${rate(verdictC)}  (${verdictC.ok}/${verdictC.total})`);
const validAccepted = validTruth.filter(([f]) => rByName.get(f)?.verdictOk).length;
console.log(`  有効局面を正しく受理:            ${validTruth.length ? ((100 * validAccepted) / validTruth.length).toFixed(1) : 'n/a'}%  (${validAccepted}/${validTruth.length})`);
const rejectOk = rejectTruth.filter(([f]) => rByName.get(f)?.verdictOk).length;
console.log(`  対象外を正しく棄却:              ${rejectTruth.length ? ((100 * rejectOk) / rejectTruth.length).toFixed(1) : 'n/a'}%  (${rejectOk}/${rejectTruth.length})`);
console.log(`  全フィールド完全一致フレーム:    ${scored.length ? ((100 * frameFull) / scored.length).toFixed(1) : 'n/a'}%  (${frameFull}/${scored.length})`);

console.log('\n--- 不一致の内訳 ---');
let any = false;
for (const r of scored) {
  if (r.discrepancies.length === 0) continue;
  any = true;
  console.log(`  [${r.frame.replace('Screenshot_', '')}]`);
  for (const d of r.discrepancies) console.log(`     - ${d}`);
}
if (!any) console.log('  （不一致なし）');

if (jsonOut) {
  writeFileSync(jsonOut, JSON.stringify({ field, results, summary: { scored: scored.length, frameFull, validAccepted, validTotal: validTruth.length, rejectOk, rejectTotal: rejectTruth.length } }, null, 2));
  console.log(`\n(JSON: ${jsonOut})`);
}
