/**
 * monotonizePush（支配半順序に沿う EV 単調化→ゼロ交差）の単体テスト。
 * MC ノイズの市松穴を除去し、支配関係に整合した連続レンジになることを固定する。
 */
import { describe, it, expect } from 'vitest';
import { comboCount, parseHandClass, rankIndex } from '@oshihiki/core';
import { HAND_CLASS_ORDER } from '../src/huEquity.js';
import { monotonizePush } from '../src/monotonize.js';

const combos = HAND_CLASS_ORDER.map((l) => comboCount(parseHandClass(l)!.kind));
function run(values: number[], threshold = 0): Record<string, boolean> {
  const p = monotonizePush({ classOrder: HAND_CLASS_ORDER, values, combos, threshold });
  return Object.fromEntries(HAND_CLASS_ORDER.map((l, i) => [l, p[i]!]));
}
const RANK = 'AKQJT98765432';
// 高カード hi のスーテッド行を強い順（キッカー idx 昇順）に並べる。
function suitedRow(hi: string): string[] {
  const out: string[] = [];
  for (let k = rankIndex(hi) + 1; k < 13; k++) out.push(`${hi}${RANK[k]}s`);
  return out;
}

describe('monotonizePush', () => {
  it('市松状の穴を消して連続レンジにする（K スーテッド行）', () => {
    const ev = new Array(HAND_CLASS_ORDER.length).fill(-1);
    // KQs..K2s に 0 近傍の市松（+.02/−.02）を仕込む。
    const row = suitedRow('K');
    row.forEach((l, i) => { ev[HAND_CLASS_ORDER.indexOf(l)] = i % 2 === 0 ? 0.02 : -0.02; });
    const push = run(ev);
    const seq = row.map((l) => push[l]!); // 強→弱
    // 連続性: いったん降りたら以降は全て降り（[T..,F..] の形）。穴（F の後に T）が無い。
    const firstFold = seq.indexOf(false);
    if (firstFold >= 0) {
      expect(seq.slice(firstFold).every((v) => v === false)).toBe(true);
    }
    // 市松の生ゼロ交差なら K7s 押し/K8s 降り等の穴が出るが、単調化後は出ない。
    expect(push['K7s'] && !push['K8s']).toBe(false);
    expect(push['K5s'] && !push['K6s']).toBe(false);
  });

  it('FP頻度 signal（threshold 0.5）でも市松を消す', () => {
    // 頻度 [0,1] の市松（0.5 近傍）を K スーテッド行に仕込む。
    const freq = new Array(HAND_CLASS_ORDER.length).fill(0);
    const row = suitedRow('K');
    row.forEach((l, i) => { freq[HAND_CLASS_ORDER.indexOf(l)] = i % 2 === 0 ? 0.6 : 0.4; });
    const push = run(freq, 0.5);
    const seq = row.map((l) => push[l]!);
    const firstFold = seq.indexOf(false);
    if (firstFold >= 0) expect(seq.slice(firstFold).every((v) => v === false)).toBe(true);
    expect(push['K7s'] && !push['K8s']).toBe(false);
  });

  it('明確な +EV/−EV は不変（AA 押し・72o 降り）', () => {
    const ev = new Array(HAND_CLASS_ORDER.length).fill(-5);
    ev[HAND_CLASS_ORDER.indexOf('AA')] = 5;
    const push = run(ev);
    expect(push['AA']).toBe(true);
    expect(push['72o']).toBe(false);
    expect(push['32o']).toBe(false);
  });

  it('ペアと非ペアは非比較（相互に拘束しない）', () => {
    // 全ペア +1・全非ペア −1 → ペアは全押し、非ペアは全降り（AKs すら降り）。
    const ev = HAND_CLASS_ORDER.map((l) => (parseHandClass(l)!.kind === 'pair' ? 1 : -1));
    const push = run(ev);
    expect(push['22']).toBe(true);
    expect(push['AA']).toBe(true);
    expect(push['AKs']).toBe(false);
    expect(push['A5s']).toBe(false);
  });

  it('ノイズ入力でも支配関係に完全整合（弱い手が押しなら強い手も押し）', () => {
    // 決定的な擬似乱数で ev を作る。
    let s = 12345;
    const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 2 ** 32; };
    const ev = HAND_CLASS_ORDER.map(() => rnd() - 0.5); // [-0.5,0.5)
    const p = monotonizePush({ classOrder: HAND_CLASS_ORDER, values: ev, combos, threshold: 0 });
    const pushOf = Object.fromEntries(HAND_CLASS_ORDER.map((l, i) => [l, p[i]!]));
    const hc = HAND_CLASS_ORDER.map((l) => parseHandClass(l)!);
    const hi = hc.map((h) => rankIndex(h.hi));
    const lo = hc.map((h) => rankIndex(h.lo));
    // 全支配ペアで「弱い手 push ⇒ 強い手 push」を確認。
    for (let i = 0; i < HAND_CLASS_ORDER.length; i++) {
      for (let j = 0; j < HAND_CLASS_ORDER.length; j++) {
        if (i === j) continue;
        const ki = hc[i]!.kind, kj = hc[j]!.kind;
        let dom = false; // i ≽ j?
        if (ki === 'pair' && kj === 'pair') dom = hi[i]! < hi[j]!;
        else if (ki === 'pair' || kj === 'pair') dom = false;
        else if (ki === kj) dom = hi[i]! <= hi[j]! && lo[i]! <= lo[j]! && !(hi[i] === hi[j] && lo[i] === lo[j]);
        else if (ki === 's' && kj === 'o') dom = hi[i]! <= hi[j]! && lo[i]! <= lo[j]!;
        if (dom && pushOf[HAND_CLASS_ORDER[j]!]) {
          expect(pushOf[HAND_CLASS_ORDER[i]!]).toBe(true);
        }
      }
    }
  });
});
