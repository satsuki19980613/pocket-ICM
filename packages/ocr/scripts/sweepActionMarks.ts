/**
 * アクションマーク認識の全数掃引（dev, 偽陽性ハンティング）。
 *
 * `evalActionMarks.ts` は正解ラベル付きの (フレーム, 席) だけを見るが、GT は
 * local-fixtures/ 全 170 枚のうち 22 枚しかカバーしない。本スクリプトは GT の有無に関わらず
 * **全 PNG × 全 6 スロット**（占有かどうかも問わない）で `recognizeMarkDiag` を走らせ、
 * 'none' 以外を返したケースを全件 TSV/JSON に書き出す。目視検証（AI が実際に画像を見て
 * TRUE/FALSE を判定する）はこのスクリプトの外、別セッションで行う
 * （[[ocr-accuracy-verification]] の規律: OCR 出力だけで真偽を決めない）。
 *
 * 使い方: npx tsx scripts/sweepActionMarks.ts [--templates assets/action_marks.json]
 *         [--out out.tsv] [--json out.json]
 *
 * 注意: 2 枚は不正な PNG（デコード不可）としてスキップする。デコード自体が失敗したファイルは
 * stderr 相当のログに 'DECODE_FAIL' として出す（コンソールは cp932 なので日本語ファイル名は
 * 出さず、拡張子やインデックスなど ASCII のみ出す）。
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from './pngCodec.js';
import { normalizeForAnchors } from '../src/upscaleNormalize.js';
import { enumerateSeats, SLOTS, type Slot } from '../src/seatEnum.js';
import { markZoneRect, pickMarkGrid } from '../src/actionMarkZone.js';
import { recognizeMarkDiag } from '../src/actionMark.js';
import { templatesFromJson } from '../src/templates.js';
import type { Rgba } from '../src/color.js';

const DIR = 'local-fixtures';
const KNOWN_BAD = new Set([
  'Screenshot_20260908-142308.ポーカーチェイス.png',
  'Screenshot_20260908-185057.ポーカーチェイス.png',
]);

const args = process.argv.slice(2);
const tplPath = args.includes('--templates') ? args[args.indexOf('--templates') + 1]! : 'assets/action_marks.json';
const outPath = args.includes('--out') ? args[args.indexOf('--out') + 1]! : null;
const jsonPath = args.includes('--json') ? args[args.indexOf('--json') + 1]! : null;
const templates = templatesFromJson(JSON.parse(readFileSync(tplPath, 'utf8')));

interface Hit {
  file: string;
  w: number;
  h: number;
  aspect: string;
  slot: Slot;
  action: string;
  conf: number;
  rawConf: number;
  ink: number;
  sat: number | null;
  plateX: number | null;
  plateY: number | null;
  plateW: number | null;
  plateH: number | null;
}

const files = readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.png'));

let decodeFail = 0;
let decodedOk = 0;
const hits: Hit[] = [];

for (const file of files) {
  if (KNOWN_BAD.has(file)) continue;
  const p = join(DIR, file);
  let dec;
  try {
    dec = decodePng(readFileSync(p));
  } catch {
    decodeFail++;
    continue;
  }
  decodedOk++;
  const img: Rgba = { w: dec.width, h: dec.height, data: dec.rgba };
  let nimg: Rgba;
  try {
    nimg = normalizeForAnchors(img).img;
  } catch {
    decodeFail++;
    continue;
  }
  let enr;
  try {
    enr = enumerateSeats(img);
  } catch {
    enr = { seats: [] as ReturnType<typeof enumerateSeats>['seats'] };
  }
  const grid = pickMarkGrid(img.w / img.h);
  for (const slot of SLOTS) {
    const seat = enr.seats.find((q) => q.slot === slot);
    let zone;
    try {
      zone = markZoneRect(nimg, slot, seat?.nameBox, grid);
    } catch {
      continue;
    }
    let read, diag;
    try {
      ({ read, diag } = recognizeMarkDiag(nimg, zone, templates));
    } catch {
      continue;
    }
    if (read.value === 'none') continue;
    hits.push({
      file,
      w: dec.width,
      h: dec.height,
      aspect: (dec.width / dec.height).toFixed(4),
      slot,
      action: read.value,
      conf: read.conf,
      rawConf: diag.rawConf,
      ink: diag.ink,
      sat: diag.plate ? diag.plate.meanSat : null,
      plateX: diag.plate ? diag.plate.rect.x : null,
      plateY: diag.plate ? diag.plate.rect.y : null,
      plateW: diag.plate ? diag.plate.rect.w : null,
      plateH: diag.plate ? diag.plate.rect.h : null,
    });
  }
}

console.log(`files: ${files.length}  decoded: ${decodedOk}  decodeFail: ${decodeFail}  hits(non-none): ${hits.length}`);

const tsvLines = [
  ['file', 'w', 'h', 'aspect', 'slot', 'action', 'conf', 'rawConf', 'ink', 'sat', 'plateX', 'plateY', 'plateW', 'plateH', 'verdict'].join('\t'),
  ...hits.map((h) =>
    [
      h.file,
      h.w,
      h.h,
      h.aspect,
      h.slot,
      h.action,
      h.conf.toFixed(3),
      h.rawConf.toFixed(3),
      h.ink.toFixed(3),
      h.sat === null ? '' : h.sat.toFixed(1),
      h.plateX ?? '',
      h.plateY ?? '',
      h.plateW ?? '',
      h.plateH ?? '',
      '', // verdict column filled in manually after visual check
    ].join('\t'),
  ),
];

if (outPath) {
  writeFileSync(outPath, tsvLines.join('\n') + '\n', 'utf8');
  console.log(`wrote ${outPath} (${hits.length} rows)`);
}
if (jsonPath) {
  writeFileSync(jsonPath, JSON.stringify(hits, null, 2), 'utf8');
  console.log(`wrote ${jsonPath}`);
}
