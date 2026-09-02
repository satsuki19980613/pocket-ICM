/** dev(実験): コンテンツ矩形を検出→較正解像度(2730×1260)へ拡大→既存抽出をそのまま実行。
 * 解像度正規化で「小さいスマホ」でも読めるかを検証する。 */
import { readFileSync } from 'node:fs';
import { decodePng } from './pngCodec.js';
import { extractRawReads, type ExtractTemplates } from '../src/extract.js';
import { detectContentRect, type ContentRect } from '../src/contentRect.js';
import { CHIPS_6MAX } from '../src/frameProfile.js';
import { templatesFromJson } from '../src/templates.js';
import { runOcrPipeline } from '../src/pipeline.js';
import type { Rgba } from '../src/color.js';

const A = 'assets';
const load = (p: string) => templatesFromJson(JSON.parse(readFileSync(p, 'utf8')));
const templates: ExtractTemplates = { digits: load(`${A}/digits.json`), ranks: load(`${A}/ranks_hero.json`), actions: load(`${A}/actions.json`), letters: load(`${A}/letters_bb.json`) };

function cropFrac(img: Rgba, cr: ContentRect): Rgba {
  const x0 = Math.max(0, Math.round(cr.x * img.w));
  const y0 = Math.max(0, Math.round(cr.y * img.h));
  const w = Math.min(img.w - x0, Math.round(cr.w * img.w));
  const h = Math.min(img.h - y0, Math.round(cr.h * img.h));
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = ((y0 + y) * img.w + (x0 + x)) * 4;
      const d = (y * w + x) * 4;
      data[d] = img.data[s]!; data[d + 1] = img.data[s + 1]!; data[d + 2] = img.data[s + 2]!; data[d + 3] = 255;
    }
  return { w, h, data };
}

/** バイリニア拡大。 */
function resample(img: Rgba, dw: number, dh: number): Rgba {
  const data = new Uint8Array(dw * dh * 4);
  const sx = img.w / dw, sy = img.h / dh;
  for (let y = 0; y < dh; y++) {
    const fy = (y + 0.5) * sy - 0.5; const y0 = Math.floor(fy); const ty = fy - y0;
    const y0c = Math.max(0, Math.min(img.h - 1, y0)); const y1c = Math.max(0, Math.min(img.h - 1, y0 + 1));
    for (let x = 0; x < dw; x++) {
      const fx = (x + 0.5) * sx - 0.5; const x0 = Math.floor(fx); const tx = fx - x0;
      const x0c = Math.max(0, Math.min(img.w - 1, x0)); const x1c = Math.max(0, Math.min(img.w - 1, x0 + 1));
      const d = (y * dw + x) * 4;
      for (let c = 0; c < 3; c++) {
        const p00 = img.data[(y0c * img.w + x0c) * 4 + c]!; const p10 = img.data[(y0c * img.w + x1c) * 4 + c]!;
        const p01 = img.data[(y1c * img.w + x0c) * 4 + c]!; const p11 = img.data[(y1c * img.w + x1c) * 4 + c]!;
        const top = p00 + (p10 - p00) * tx; const bot = p01 + (p11 - p01) * tx;
        data[d + c] = Math.round(top + (bot - top) * ty);
      }
      data[d + 3] = 255;
    }
  }
  return { w: dw, h: dh, data };
}

const frame = process.argv[2]!;
const img = decodePng(readFileSync(`local-fixtures/${frame}`));
const rgba: Rgba = { w: img.width, h: img.height, data: img.rgba };
const crArg = process.argv[3];
const cr: ContentRect = crArg ? (() => { const [x, y, w, h] = crArg.split(',').map(Number); return { x, y, w, h }; })() : detectContentRect(rgba, CHIPS_6MAX, templates.digits);
console.log(`detected cr=x${cr.x} y${cr.y} w${cr.w} h${cr.h}  (src ${rgba.w}x${rgba.h})`);
const up = resample(cropFrac(rgba, cr), 2730, 1260);
if (process.argv.includes('save')) { const { encodePng } = await import('./pngCodec.js'); const { writeFileSync } = await import('node:fs'); writeFileSync('C:/Users/SA641~1.SAT/AppData/Local/Temp/up.png', encodePng({ width: up.w, height: up.h, rgba: up.data })); console.log('saved up.png'); }
const dm = process.argv[4] === 'bb' ? 'bb' : process.argv[4] === 'chips' ? 'chips' : undefined;
const reads = extractRawReads(up, CHIPS_6MAX, templates, { betMinCh: 125, ...(dm ? { displayMode: dm } : {}) });
const f = (r: { value: number; conf: number }) => `${Number.isFinite(r.value) ? r.value.toFixed(2) : 'NaN'}(${r.conf.toFixed(2)})`;
console.log(`street=${reads.street.value} blinds=${f(reads.blinds.sb)}/${f(reads.blinds.bb)} ante=${f(reads.ante.amount)} pot=${f(reads.pot)} hero=${reads.heroHand.value}(${reads.heroHand.conf.toFixed(2)}) mode=${reads.displayMode}`);
for (const s of reads.seats) console.log(`  ${s.id} ${s.isHero ? 'H' : ' '}${s.isButton ? 'D' : ' '} occ=${s.occupancy.value} act=${s.action.value}(${s.action.conf.toFixed(2)}) stack=${f(s.stack)} bet=${f(s.bet)}`);
const res = runOcrPipeline(reads);
console.log(`pipeline ok=${res.ok}${res.issues.length ? ' issues: ' + res.issues.join(' | ') : ''}`);
if (res.state) console.log('seats:', res.state.seats.map((s) => `${s.pos}:${s.state} stk=${s.stack.toFixed(1)} bet=${s.bet}`).join(' '));
