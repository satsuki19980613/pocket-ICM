/**
 * blinds "330/660" の '/' グリフをテンプレ化して digits.json に label "/" として追加（dev）。
 * 使い方: tsx genSlash.ts <frame.png> <x,y,w,h(blindsnum割合)> <compIndex>
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { decodePng, type Raster } from './pngCodec.js';
import { whiteMask, digitComponents, grayFromRgba, DIGIT_NORM_H } from '../src/numberField.js';
import { crop, resize } from '../src/raster.js';
import type { Rgba } from '../src/color.js';
import type { Rect } from '../src/types.js';

const DIGITS = 'local-fixtures/digits.json';
const [, , frame, rectStr, idxStr] = process.argv;
const fr = (rectStr ?? '0.172,0.012,0.084,0.044').split(',').map(Number);
const idx = Number(idxStr ?? '3');

const img = decodePng(readFileSync(frame ?? 'local-fixtures/Screenshot_20260901-142820.png'));
const rgba: Rgba = { w: img.width, h: img.height, data: img.rgba };
const rect: Rect = { x: Math.round(fr[0]! * img.width), y: Math.round(fr[1]! * img.height), w: Math.round(fr[2]! * img.width), h: Math.round(fr[3]! * img.height) };
const strip = grayFromRgba(rgba, rect);
const comps = digitComponents(whiteMask(rgba, rect));
console.log(`comps=${comps.length}`, comps.map((c, i) => `${i}:x${c.x}w${c.w}`).join(' '));
const c = comps[idx]!;
const g = crop(strip, c);
const nw = Math.max(1, Math.round((g.w * DIGIT_NORM_H) / g.h));
const norm = resize(g, nw, DIGIT_NORM_H);

const j = JSON.parse(readFileSync(DIGITS, 'utf8')) as { source?: string; labels?: string[]; templates: Record<string, { w: number; h: number; data: number[] }> };
j.templates['/'] = { w: norm.w, h: norm.h, data: Array.from(norm.data) };
if (j.labels && !j.labels.includes('/')) j.labels.push('/');
writeFileSync(DIGITS, JSON.stringify(j));
console.log(`added '/' template ${norm.w}x${norm.h}; labels now:`, Object.keys(j.templates).join(' '));
