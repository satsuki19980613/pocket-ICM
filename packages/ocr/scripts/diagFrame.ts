/**
 * 1 枚診断（dev 専用）: アプリの本番経路（packages/app/src/ocr/prefill.ts と同じ順序）を
 * Node で再現し、「読み取りエラーになった写真がどこで落ちたか」を出す。
 *
 * 利用者から「この写真が読めない」と来たときの一次切り分け用。サーバーの ocr_reads 行と
 * 同じ内容（displayMode / street / 生読み取り / issues / issueCodes）が手元で見られる。
 *
 * 使い方: npx tsx scripts/diagFrame.ts <image.png>
 *   例: npx tsx scripts/diagFrame.ts local-fixtures/Screenshot_20260910-192316.png
 */
import { readFileSync } from 'node:fs';
import { decodePng } from './pngCodec.js';

import {
  extractAnchored,
  extractRawReadsAuto,
  runOcrPipeline,
  pickSeatAnchorGrid,
  buildReadout,
  CHIPS_6MAX,
  IOS_6MAX,
  FULL_FRAME,
  templatesFromJson,
  type RawReads,
  type ExtractTemplates,
} from '@oshihiki/ocr';

const A = 'assets';
const load = (p: string) => templatesFromJson(JSON.parse(readFileSync(p, 'utf8')));
const templates: ExtractTemplates = {
  digits: load(`${A}/digits.json`),
  ranks: load(`${A}/ranks_hero.json`),
  actions: load(`${A}/actions.json`),
  letters: load(`${A}/letters_bb.json`),
  marks: load(`${A}/action_marks.json`),
};

const input = process.argv[2];
if (!input) {
  console.error('usage: tsx diagPixel.ts <image.png>');
  process.exit(1);
}

const png = decodePng(readFileSync(input));
const img = { w: png.width, h: png.height, data: png.rgba };
const aspect = img.w / img.h;
console.log('=== 入力 ===');
console.log(`size    : ${img.w}x${img.h}`);
console.log(`aspect  : ${aspect.toFixed(4)}`);
console.log(`grid    : ${pickSeatAnchorGrid(aspect) ? '静的アンカーグリッドあり' : 'なし（検出のまま）'}`);

let reads: RawReads;
let path = 'anchored';
try {
  const seatAnchors = pickSeatAnchorGrid(aspect);
  reads = extractAnchored(img, templates, seatAnchors ? { seatAnchors } : {});
} catch (e) {
  path = 'fallback(fixed-coords)';
  console.log(`\n!! extractAnchored が throw: ${(e as Error).message}`);
  const isAndroid = img.w >= 2400;
  reads = isAndroid
    ? extractRawReadsAuto(img, CHIPS_6MAX, templates, { betMinCh: 125 }).reads
    : extractRawReadsAuto(img, IOS_6MAX, templates, { betMinCh: 125, contentRect: FULL_FRAME }).reads;
}

console.log(`\n=== 抽出経路: ${path} ===`);
console.log(`displayMode : ${reads.displayMode}`);
console.log(`street      : ${JSON.stringify(reads.street)}`);
console.log(`blinds      : ${JSON.stringify(reads.blinds)}`);
console.log(`ante        : ${JSON.stringify(reads.ante)}`);
console.log(`pot         : ${JSON.stringify(reads.pot)}`);
console.log(`heroHand    : ${JSON.stringify(reads.heroHand)}`);
console.log(`button      : ${JSON.stringify(reads.button)}`);
console.log('seats       :');
for (const [id, s] of Object.entries(reads.seats ?? {})) {
  console.log(`  ${id}: ${JSON.stringify(s)}`);
}

if (reads.displayMode !== 'bb') {
  const readout = buildReadout(reads, { issues: ['chips mode'] });
  console.log('\n=== 早期棄却: displayMode !== bb ===');
  console.log(`issueCodes: ${JSON.stringify(readout.issueCodes)}`);
  process.exit(0);
}

const res = runOcrPipeline(reads);
console.log('\n=== pipeline ===');
console.log(`ok          : ${res.ok}`);
console.log(`issues      : ${JSON.stringify(res.issues, null, 2)}`);
console.log(`issueCodes  : ${JSON.stringify(res.readout.issueCodes)}`);
console.log(`lowConf     : ${JSON.stringify(res.lowConfidenceFields)}`);
if (res.state) console.log(`state       : ${JSON.stringify(res.state, null, 2)}`);
