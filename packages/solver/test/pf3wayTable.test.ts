/**
 * pf3wayTable ランタイム（参照＋トリリニア補間）の単体テスト。
 * 合成テーブルで「補間の数値」「範囲判定」「eqPre再計算」を固定し回帰を防ぐ。
 */
import { describe, it, expect } from 'vitest';
import type { BoardState } from '@oshihiki/core';
import { buildPf3wayTable, lookupPf3way, pf3wayInRange, type Pf3wayMeta } from '../src/pf3wayTable.js';

const SB = 0.5, BB = 1, ANTE = 0.25;
const ORDER = ['BU', 'SB', 'BB'] as const;

// G=2 の合成テーブル: 1ノード, classOrder=['AA','72o'], stride=2+3=5。
// 各格子点の node ev[0] = i*100+j*10+k（座標をエンコード）で補間を検証可能に。
function synthTable(): ReturnType<typeof buildPf3wayTable> {
  const meta: Pf3wayMeta = {
    kind: 'pf3way-evdiff', blinds: { sb: SB, bb: BB }, ante: { scheme: 'all', amount: ANTE },
    order: [...ORDER], axis: [10, 20],
    nodeKeys: ['BU:P,SB:-,BB:-'], nodeActors: ['BU'], nodeTypes: ['PU'],
    classOrder: ['AA', '72o'], stride: 5, floatsPerNode: 2, samples: 1,
  };
  const G = 2, stride = 5;
  const data = new Float32Array(G * G * G * stride);
  for (let i = 0; i < G; i++) for (let j = 0; j < G; j++) for (let k = 0; k < G; k++) {
    const base = ((i * G + j) * G + k) * stride;
    data[base + 0] = i * 100 + j * 10 + k; // ev['AA']
    data[base + 1] = -(i * 100 + j * 10 + k); // ev['72o'] 逆符号
    data[base + 2] = i;      // eqPost BU
    data[base + 3] = j;      // eqPost SB
    data[base + 4] = k;      // eqPost BB
  }
  return buildPf3wayTable(meta, data);
}

function state(bu: number, sb: number, bbTot: number): BoardState {
  const seats = [
    { pos: 'BU' as const, stack: bu - 0 - ANTE, state: 'live' as const, bet: 0 },
    { pos: 'SB' as const, stack: sb - SB - ANTE, state: 'live' as const, bet: SB },
    { pos: 'BB' as const, stack: bbTot - BB - ANTE, state: 'live' as const, bet: BB },
  ];
  return {
    street: 'preflop', blinds: { sb: SB, bb: BB }, ante: { scheme: 'all', amount: ANTE },
    heroHand: 'AA', playersLeft: 3, seats, heroPos: 'BU',
    pot: seats.reduce((a, s) => a + s.bet, 0) + ANTE * 3,
  } as BoardState;
}

describe('pf3wayTable interpolation', () => {
  it('中心点はトリリニア平均になる', () => {
    const t = synthTable();
    const r = lookupPf3way(t, state(15, 15, 15)); // fx=fy=fz=0.5
    // 8隅の i*100+j*10+k 平均 = 55.5
    expect(r.nodes[0]!.ev['AA']!).toBeCloseTo(55.5, 3);
    expect(r.nodes[0]!.ev['72o']!).toBeCloseTo(-55.5, 3);
    // eqPost は各軸 0.5
    expect(r.equity['BU']!.post).toBeCloseTo(0.5, 3);
    expect(r.equity['SB']!.post).toBeCloseTo(0.5, 3);
    expect(r.equity['BB']!.post).toBeCloseTo(0.5, 3);
  });

  it('格子点そのものは格納値に一致', () => {
    const t = synthTable();
    const r = lookupPf3way(t, state(20, 10, 20)); // i=1,j=0,k=1 → 101
    expect(r.nodes[0]!.ev['AA']!).toBeCloseTo(101, 3);
  });

  it('ev>=0 の手だけ push レンジに入る（ゼロ交差）', () => {
    const t = synthTable();
    const r = lookupPf3way(t, state(15, 15, 15)); // AA:+55.5(push), 72o:-55.5(fold)
    expect(r.nodes[0]!.hands).toContain('AA');
    expect(r.nodes[0]!.hands).not.toContain('72o');
    expect(r.nodes[0]!.freq['AA']!).toBe(1);
    expect(r.nodes[0]!.freq['72o']!).toBe(0);
  });

  it('範囲判定: 全席上限以下=可, 相手深/hero深/人数不一致=不可（厳密MCへ）', () => {
    const t = synthTable(); // hero=BU, hi=20
    expect(pf3wayInRange(t, state(15, 15, 15))).toBe(true);
    // 相手（BB）が上限超 → クランプせず不可（厳密 MC へ）。
    expect(pf3wayInRange(t, state(15, 15, 25))).toBe(false);
    // hero(BU) 自身が上限超 → 不可。
    expect(pf3wayInRange(t, state(25, 15, 15))).toBe(false);
    expect(pf3wayInRange(t, state(5, 5, 5))).toBe(true); // 下限未満はクランプ許容
    const s4 = state(15, 15, 15); (s4 as { playersLeft: number }).playersLeft = 4;
    expect(pf3wayInRange(t, s4)).toBe(false);
  });

  it('eqPre はスタックから再計算される（有限値）', () => {
    const t = synthTable();
    const r = lookupPf3way(t, state(18, 12, 9));
    for (const p of ORDER) expect(Number.isFinite(r.equity[p]!.pre)).toBe(true);
  });
});
