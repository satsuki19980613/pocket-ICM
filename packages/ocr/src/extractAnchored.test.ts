/**
 * extractAnchored（§B1）のスモークテスト。実フィクスチャ（local-fixtures/, gitignore）が在る場合のみ
 * 採点し、無ければ skip（CI では fixtures 非同梱 → skip）。全 27 枚＋劣化 1310 の詳細は
 * scripts/_EXTRACT_RESULTS.md 参照（この test は回帰検知の最小サンプル）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { templatesFromJson } from './templates.js';
import { extractAnchored, type AnchorTemplates } from './extractAnchored.js';
import { runOcrPipeline } from './pipeline.js';
import { decodePng } from '../scripts/pngCodec.js';
import type { Rgba } from './color.js';

const A = 'packages/ocr/assets';
const load = (p: string) => templatesFromJson(JSON.parse(readFileSync(p, 'utf8')));
const templates: AnchorTemplates = {
  digits: load(`${A}/digits.json`),
  ranks: load(`${A}/ranks_hero.json`),
  letters: load(`${A}/letters_bb.json`),
};
const DIR = 'packages/ocr/local-fixtures';

interface Expect { pl: number; heroPos: string; pot: number; hand: string; stacks?: Record<string, number>; }
// AI 目視 GT（accuracy.groundtruth.json / iphone GT）からの抜粋。stacks は本番 extractRawReadsAuto と
// 一致する root stack（ポジション別, ±0.05）。§B9 bar #1 の stack parity 回帰検知。
const CASES: Record<string, Expect> = {
  // 通常局面: SB/BB のブラインド投函が root に credit される（fix 1: bet 読み）。SB=15.1/BB=8.7 は
  // bet=0 だと 14.6/7.7 とずれる（実測の系統オフセット）。
  'Screenshot_20260902-114437.png': { pl: 5, heroPos: 'SB', pot: 2.8, hand: 'T4o', stacks: { SB: 15.1, BB: 8.7, BU: 34.9, UTG: 71.3, CO: 92.2 } },
  'Screenshot_20260902-114732.png': { pl: 4, heroPos: 'CO', pot: 2.5, hand: 'T6s' },
  // HU allin: SB(BTN) が 5.9 BB をシューブ。bet を読まないと root 0.5（allin bet が失われ潰れる, fix 2）。
  'Screenshot_20260902-123636.png': { pl: 2, heroPos: 'BB', pot: 7.4, hand: 'QJs', stacks: { SB: 5.4, BB: 17 } },
  // 3-max allin: BU が 9.6 BB シューブ。bet を読まないと root 1（fix 2）。
  'Screenshot_20260902-115309.png': { pl: 3, heroPos: 'SB', pot: 11.8, hand: '99', stacks: { BU: 9.6, SB: 21.1, BB: 22 } },
  // iOS 6-max: hero BC（BU）＋ 折れコーナー BR（CO）の stack を固定フラクショナル y フォールバックで
  // 復元（fix 3, 従来は NaN→0）。
  'E4073E5F-9454-480E-AC61-C15E6728DCBD.png': { pl: 6, heroPos: 'BU', pot: 3.0, hand: 'KJo', stacks: { BU: 9.4, CO: 16.4, HJ: 27.7, UTG: 13.2, SB: 10.9, BB: 19.2 } },
  // Android 6-max: hero BC 手番グロー席（BU）＋ 折れ BR（CO）の stack をフォールバックで復元（fix 3）。
  'Screenshot_20260902-203304.png': { pl: 6, heroPos: 'BU', pot: 3.0, hand: 'KJo', stacks: { BU: 9.4, CO: 16.4, HJ: 27.7, UTG: 13.2, SB: 10.9, BB: 19.2 } },
};

function read(name: string) {
  const img = decodePng(readFileSync(`${DIR}/${name}`));
  const rgba: Rgba = { w: img.width, h: img.height, data: img.rgba };
  const reads = extractAnchored(rgba, templates);
  return { reads, res: runOcrPipeline(reads) };
}

describe('extractAnchored end-to-end (fixture-gated)', () => {
  for (const [name, ex] of Object.entries(CASES)) {
    const present = existsSync(`${DIR}/${name}`);
    it.runIf(present)(`${name}: playersLeft/heroPos/pot/heroHand/stacks`, () => {
      const { reads, res } = read(name);
      expect(res.ok).toBe(true);
      expect(res.state?.playersLeft).toBe(ex.pl);
      expect(res.state?.heroPos).toBe(ex.heroPos);
      expect(reads.pot.value).toBeCloseTo(ex.pot, 1);
      expect(reads.heroHand.value).toBe(ex.hand);
      if (ex.stacks) {
        const byPos = new Map(res.state!.seats.map((s) => [s.pos, s.stack]));
        for (const [pos, v] of Object.entries(ex.stacks)) {
          expect(byPos.get(pos as never), `${pos} root stack`).toBeCloseTo(v, 1);
        }
      }
    });
    it.skipIf(present)(`${name}: skipped (no fixture)`, () => {});
  }
});
