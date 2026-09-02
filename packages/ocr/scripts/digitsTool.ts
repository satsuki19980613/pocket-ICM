/**
 * 較正ツール（dev 専用）: 数字テンプレ(0-9)を生成し、AI 目視の真値と OCR 出力を照合する。
 * カード認識と同型（scripts/detectRecognize.ts）の数字版。認識コアは src/numberField.ts。
 *
 * 使い方:
 *   build : tsx digitsTool.ts build <templates.json> <input.png> <x,y,w,h> <truth>
 *   recog : tsx digitsTool.ts recog <templates.json> <input.png> <x,y,w,h> <truth>
 *   multi : tsx digitsTool.ts multi <templates.json> <input.png> <name=x,y,w,h=truth> ...
 * x,y,w,h は [0,1] の割合矩形。truth は "13,491" 等（コンマは自動で無視）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { decodePng } from './pngCodec.js';
import { parseAmount } from '../src/digits.js';
import { loadTemplates, recognizeField, fieldGlyphRects, normGlyph, type TplStore } from './digitsCore.js';

const [, , mode, tplPath, input] = process.argv;
const img = decodePng(readFileSync(input!));

function parseFrac(s: string): [number, number, number, number] {
  const [x, y, w, h] = s.split(',').map(Number);
  return [x!, y!, w!, h!];
}

if (mode === 'build') {
  const [, , , , , zoneStr, truth] = process.argv;
  const frac = parseFrac(zoneStr!);
  const { rects, strip } = fieldGlyphRects(img, frac);
  const chars = [...truth!.replace(/[^0-9]/g, '')];
  console.log(`detected ${rects.length} glyphs; truth chars ${chars.length} (${truth})`);
  if (rects.length !== chars.length) {
    console.error('グリフ数と真値文字数が不一致。領域を見直す。');
    rects.forEach((r, i) => console.error(`  glyph[${i}] x=${r.x} w=${r.w} h=${r.h}`));
    process.exit(1);
  }
  const store: TplStore = existsSync(tplPath!)
    ? (JSON.parse(readFileSync(tplPath!, 'utf8')).templates ?? {})
    : {};
  rects.forEach((r, i) => {
    const g = normGlyph(strip, r);
    store[chars[i]!] = { w: g.w, h: g.h, data: [...g.data] };
  });
  writeFileSync(tplPath!, JSON.stringify({ templates: store }));
  console.log(`built/merged → ${Object.keys(store).length} templates: ${Object.keys(store).sort().join(' ')}`);
} else if (mode === 'recog') {
  const [, , , , , zoneStr, truth] = process.argv;
  const templates = loadTemplates(tplPath!);
  const r = recognizeField(img, parseFrac(zoneStr!), templates);
  const ok = r.value !== null && r.value === parseAmount(truth!);
  console.log(`${ok ? 'OK ' : 'XX '} truth=${truth} → read="${r.text}" (${r.value}) minScore=${r.minScore.toFixed(3)}`);
  console.log(`  glyphs: ${r.glyphs.map((g) => `${g.label}:${g.score.toFixed(2)}`).join(' ')}`);
  process.exit(ok ? 0 : 2);
} else if (mode === 'multi') {
  const specs = process.argv.slice(5);
  const templates = loadTemplates(tplPath!);
  let ok = 0, total = 0;
  for (const spec of specs) {
    const [name, zoneStr, truth] = spec.split('=');
    const r = recognizeField(img, parseFrac(zoneStr!), templates);
    const good = r.value !== null && r.value === parseAmount(truth!);
    total++; if (good) ok++;
    console.log(`${good ? 'OK ' : 'XX '} ${name!.padEnd(10)} truth=${(truth ?? '').padEnd(8)} read="${r.text}" (${r.value}) minScore=${r.minScore.toFixed(3)}`);
  }
  console.log(`\n数字フィールド一致: ${ok}/${total}`);
  process.exit(ok === total ? 0 : 2);
} else {
  console.error('mode は build | recog | multi');
  process.exit(1);
}
