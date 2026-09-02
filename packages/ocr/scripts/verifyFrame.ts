/**
 * 較正ツール（dev 専用）: 6 人レイアウトの領域をベイクし、1 フレームの全数字フィールドを
 * AI 目視の真値と照合する。並列較正エージェント用に、画像＋真値だけ渡せば動くようにした。
 *
 * 使い方:
 *   tsx verifyFrame.ts <input.png> <templates.json> "field=truth,field=truth,..."
 *   例: tsx verifyFrame.ts shot.png digits.json "herostk=8478,betSB=400,pot=2400,ante=200"
 *
 * field 名: ante pot herostk betSB betBB bbstk tlstk tcstk trstk brstk
 *   （物理席: hero=下中央/SB席, bb=下左, br=下右/D近辺, tl=上左, tc=上中央, tr=上右）
 * 真値はカンマ抜きの数字（"13491"）。真値未指定フィールドは読みだけ表示（採点しない）。
 * blinds(SB/BB "330/660") は "/" を含むため本ツールでは扱わない（後続で SB/BB 2 領域に分割）。
 */
import { readFileSync } from 'node:fs';
import { decodePng } from './pngCodec.js';
import { loadTemplates, recognizeField } from './digitsCore.js';
import { CHIPS_6MAX_NUMBER_REGIONS } from '../src/numberLayout.js';

/**
 * 領域プロファイルは src の CHIPS_6MAX_NUMBER_REGIONS（製品コード, 単一の真実）を使う。
 * betSB/betBB は未較正の実験領域なのでここだけローカルに足す。
 */
const REGIONS: Record<string, { frac: readonly [number, number, number, number]; minCh?: number }> = {
  ...CHIPS_6MAX_NUMBER_REGIONS,
  betSB: { frac: [0.51, 0.595, 0.06, 0.042] },
  betBB: { frac: [0.30, 0.475, 0.075, 0.042] },
};

const [, , input, tplPath, truthsStr] = process.argv;
if (!input || !tplPath) {
  console.error('usage: verifyFrame.ts <input.png> <templates.json> "field=truth,..."');
  process.exit(1);
}
const img = decodePng(readFileSync(input));
const templates = loadTemplates(tplPath);
const truths: Record<string, string> = {};
for (const kv of (truthsStr ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
  const [k, v] = kv.split('=');
  if (k && v !== undefined) truths[k] = v.replace(/[^0-9]/g, '');
}

let ok = 0, scored = 0;
for (const [name, def] of Object.entries(REGIONS)) {
  const r = recognizeField(img, def.frac, templates, { minCh: def.minCh });
  const truth = truths[name];
  if (truth !== undefined) {
    scored++;
    const good = r.value !== null && String(r.value) === String(Number(truth));
    if (good) ok++;
    console.log(`${good ? 'OK ' : 'XX '} ${name.padEnd(8)} truth=${truth.padEnd(8)} read="${r.text}" (${r.value}) minScore=${r.minScore.toFixed(3)}`);
  } else {
    console.log(`.. ${name.padEnd(8)} (no truth)    read="${r.text}" (${r.value}) minScore=${r.minScore.toFixed(3)}`);
  }
}
console.log(`\n一致: ${ok}/${scored}`);
process.exit(ok === scored ? 0 : 2);
