/**
 * 較正ツール（dev 専用）: 白札検出→正規化→角切り で テンプレ生成/認識を行い、
 * AI 目視 vs OCR を照合する。固定座標の弱点（1つズレ混同）を検出で解消できるか検証。
 *
 * 使い方:
 *   build : tsx detectRecognize.ts build <templates.json> <input.png> <zx,zy,zw,zh> <threshold> <label,label,...>
 *   recog : tsx detectRecognize.ts recog <templates.json> <input.png> <zx,zy,zw,zh> <threshold> <truth,truth,...>
 * label/truth は検出順（行ごと左→右）。数を合わせること。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { decodePng, type Raster } from './pngCodec.js';
import { findCardRects, cornerOf } from '../src/detect.js';
import { resize } from '../src/raster.js';
import { bestMatch, matchConfidence, type Template } from '../src/match.js';
import { recognizeSuit } from '../src/color.js';
import type { Gray, Rect } from '../src/types.js';

const CW = 30, CH = 38; // 正規化した角のサイズ

function subGray(r: Raster, fx: number, fy: number, fw: number, fh: number): Gray {
  const x0 = Math.round(fx * r.width), y0 = Math.round(fy * r.height);
  const w = Math.round(fw * r.width), h = Math.round(fh * r.height);
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = ((y0 + y) * r.width + (x0 + x)) * 4;
      data[y * w + x] = (r.rgba[s]! * 77 + r.rgba[s + 1]! * 150 + r.rgba[s + 2]! * 29) >> 8;
    }
  return { w, h, data };
}
function cropGray(g: Gray, r: Rect): Gray {
  const data = new Uint8Array(r.w * r.h);
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) data[y * r.w + x] = g.data[(r.y + y) * g.w + (r.x + x)]!;
  return { w: r.w, h: r.h, data };
}

const [, , mode, tplPath, input, zoneStr, thStr, labelsStr] = process.argv;
const [zx, zy, zw, zh] = zoneStr!.split(',').map(Number);
const labels = (labelsStr ?? '').split(',').filter(Boolean);
const img = decodePng(readFileSync(input));
const gray = subGray(img, zx!, zy!, zw!, zh!);
const rects = findCardRects(gray, { threshold: Number(thStr), minAreaFrac: 0.008, aspectRange: [0.4, 0.78], minFill: 0.2, closeRadius: 1 });
console.log(`detected ${rects.length} cards; labels given ${labels.length}`);

const corners = rects.map((r) => resize(cropGray(gray, cornerOf(r)), CW, CH));

if (mode === 'build') {
  if (labels.length !== rects.length) { console.error('label 数が検出数と不一致'); process.exit(1); }
  // 既存 JSON があればマージ（複数スクショから全ランクを集める）。
  const templates: Record<string, { w: number; h: number; data: number[] }> =
    existsSync(tplPath!) ? (JSON.parse(readFileSync(tplPath!, 'utf8')).templates ?? {}) : {};
  corners.forEach((c, i) => { templates[labels[i]!] = { w: c.w, h: c.h, data: [...c.data] }; });
  writeFileSync(tplPath!, JSON.stringify({ templates }));
  console.log(`built/merged → ${Object.keys(templates).length} templates: ${Object.keys(templates).sort().join(' ')}`);
} else {
  const tplRaw = JSON.parse(readFileSync(tplPath!, 'utf8')) as { templates: Record<string, { w: number; h: number; data: number[] }> };
  const templates: Template[] = Object.entries(tplRaw.templates).map(([label, g]) => ({ label, img: { w: g.w, h: g.h, data: Uint8Array.from(g.data) } }));
  const rankOf = (code: string) => code.slice(0, -1); // 真ラベルは "4h"/"10d"/"Js" → rank
  const rankSet = new Set(templates.map((t) => t.label)); // テンプレラベルはランク直接
  const x0z = Math.round(zx! * img.width), y0z = Math.round(zy! * img.height);
  const rgbaImg = { w: img.width, h: img.height, data: img.rgba };
  let rankOk = 0, cardOk = 0, tested = 0;
  rects.forEach((r, i) => {
    const truth = labels[i] ?? '?';
    const c = corners[i]!;
    const m = bestMatch(c, templates);
    const predRank = m.label; // テンプレラベル＝ランク
    // スートは色（4 色デッキ）。絵札は顔絵が混じるので左上のランク文字だけを狭く取る。
    const cc = cornerOf(r, 0.42, 0.30);
    const suit = recognizeSuit(rgbaImg, { x: x0z + cc.x, y: y0z + cc.y, w: cc.w, h: cc.h });
    const predCard = predRank + suit.value;
    const canTest = rankSet.has(rankOf(truth)); // rank テンプレが在るものだけ公平に判定
    const rOk = predRank === rankOf(truth);
    const cOk = predCard === truth;
    if (canTest) { tested++; if (rOk) rankOk++; if (cOk) cardOk++; }
    console.log(`${canTest ? (cOk ? 'OK ' : 'XX ') : '.. '} truth=${truth.padEnd(3)} rank=${predRank.padEnd(2)} suit=${suit.value} → ${predCard.padEnd(3)} (rankScore=${m.score.toFixed(3)} suitConf=${suit.conf.toFixed(2)})${canTest ? '' : ' (rankテンプレ外)'}`);
  });
  console.log(`\nrank 一致: ${rankOk}/${tested} | フルカード一致: ${cardOk}/${tested}`);
}
