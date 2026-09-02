/**
 * 較正ツール（dev 専用）: 1 フィールドの領域 nudge ＋ 白マスク閾値をグリッド探索し、
 * 複数フレームの真値に対して最も多く正読する設定を見つける。tlstk 等の系統的失敗の詰めに使う。
 *
 * 使い方:
 *   tsx tuneField.ts <field> <truths.tsv> <templates.json> <baseX,baseY,baseW,baseH>
 * truths.tsv: 各行 "<frameId>\t<field=truth,...>"（verifyFrame と同形式, カンマ区切り）。
 * frameId は local-fixtures/Screenshot_20260901-<frameId>.png を指す。
 */
import { readFileSync } from 'node:fs';
import { decodePng, type Raster } from './pngCodec.js';
import { loadTemplates, recognizeField } from './digitsCore.js';

const [, , field, tsvPath, tplPath, baseStr] = process.argv;
if (!field || !tsvPath || !tplPath || !baseStr) {
  console.error('usage: tuneField.ts <field> <truths.tsv> <templates.json> <x,y,w,h>');
  process.exit(1);
}
const [bx, by, bw, bh] = baseStr.split(',').map(Number) as [number, number, number, number];
const templates = loadTemplates(tplPath);

// フレームと当該 field の真値を集める。
const cases: { id: string; img: Raster; truth: string }[] = [];
for (const raw of readFileSync(tsvPath, 'utf8').split('\n')) {
  const line = raw.trim();
  if (!line) continue;
  const [id, truthsStr] = line.split('\t');
  const kv = (truthsStr ?? '').split(',').map((s) => s.trim());
  const found = kv.map((s) => s.split('=')).find(([k]) => k === field);
  if (!found) continue;
  const truth = String(Number(found[1]!.replace(/[^0-9]/g, '')));
  const img = decodePng(readFileSync(`local-fixtures/Screenshot_20260901-${id}.png`));
  cases.push({ id: id!, img, truth });
}
console.log(`field=${field} frames=${cases.length} base=[${baseStr}]`);

const dxs = [-0.004, -0.002, 0, 0.002];
const dys = [-0.004, -0.002, 0, 0.002, 0.004];
const dws = [-0.005, 0, 0.006, 0.012];
const dhs = [-0.004, 0, 0.006];
const minChs = [150, 168, 185, 200];

interface Res { cfg: string; ok: number; detail: string }
const results: Res[] = [];
for (const dx of dxs) for (const dy of dys) for (const dw of dws) for (const dh of dhs) for (const mc of minChs) {
  const frac: [number, number, number, number] = [bx + dx, by + dy, bw + dw, bh + dh];
  let ok = 0; const det: string[] = [];
  for (const c of cases) {
    const r = recognizeField(c.img, frac, templates, { minCh: mc });
    const good = r.value !== null && String(r.value) === c.truth;
    if (good) ok++;
    else det.push(`${c.id}:${c.truth}→${r.value}`);
  }
  results.push({ cfg: `dx=${dx} dy=${dy} dw=${dw} dh=${dh} minCh=${mc}`, ok, detail: det.join(' ') });
}
results.sort((a, b) => b.ok - a.ok);
console.log(`\n-- top configs (of ${results.length}) --`);
for (const r of results.slice(0, 12)) {
  console.log(`${r.ok}/${cases.length}  ${r.cfg}   fails: ${r.detail}`);
}
