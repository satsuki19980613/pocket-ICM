/**
 * 汎用 pfTable ランタイム（D次元多重線形補間）の単体テスト。
 * 4人（クアッドリニア, D=4, 2^D=16隅）の合成テーブルで補間の数値・範囲判定・
 * eqPre再計算・interpExplBound を固定し、次元一般化の回帰を防ぐ。
 * （3人トリリニアは pf3wayTable.test.ts が別途カバー＝両次元を検証。）
 */
import { describe, it, expect } from 'vitest';
import type { BoardState } from '@oshihiki/core';
import { buildPfTable, lookupPf, pfInRange, pfCoverage, type PfMeta } from '../src/pfTable.js';

const SB = 0.5, BB = 1, ANTE = 0.25;
const ORDER = ['CO', 'BU', 'SB', 'BB'] as const;

// G=2, D=4 の合成テーブル: 1ノード, classOrder=['AA','72o'], stride=2+4=6。
// 各格子点の node ev[0] = i*1000+j*100+k*10+l（座標エンコード）で補間を検証可能に。
function synthTable(interpExplBound?: number): ReturnType<typeof buildPfTable> {
  const meta: PfMeta = {
    kind: 'pf4way-evdiff', blinds: { sb: SB, bb: BB }, ante: { scheme: 'all', amount: ANTE },
    order: [...ORDER], axis: [10, 20],
    nodeKeys: ['CO:P,BU:-,SB:-,BB:-'], nodeActors: ['CO'], nodeTypes: ['PU'],
    classOrder: ['AA', '72o'], stride: 6, floatsPerNode: 2, samples: 1,
    ...(interpExplBound !== undefined ? { interpExplBound } : {}),
  };
  const G = 2, stride = 6;
  const data = new Float32Array(G ** 4 * stride);
  for (let i = 0; i < G; i++) for (let j = 0; j < G; j++) for (let k = 0; k < G; k++) for (let l = 0; l < G; l++) {
    const flat = ((i * G + j) * G + k) * G + l;
    const base = flat * stride;
    const code = i * 1000 + j * 100 + k * 10 + l;
    data[base + 0] = code;       // ev['AA']
    data[base + 1] = -code;      // ev['72o'] 逆符号
    data[base + 2] = i;          // eqPost CO
    data[base + 3] = j;          // eqPost BU
    data[base + 4] = k;          // eqPost SB
    data[base + 5] = l;          // eqPost BB
  }
  return buildPfTable(meta, data);
}

function state(co: number, bu: number, sb: number, bbTot: number): BoardState {
  const seats = [
    { pos: 'CO' as const, stack: co - 0 - ANTE, state: 'live' as const, bet: 0 },
    { pos: 'BU' as const, stack: bu - 0 - ANTE, state: 'live' as const, bet: 0 },
    { pos: 'SB' as const, stack: sb - SB - ANTE, state: 'live' as const, bet: SB },
    { pos: 'BB' as const, stack: bbTot - BB - ANTE, state: 'live' as const, bet: BB },
  ];
  return {
    street: 'preflop', blinds: { sb: SB, bb: BB }, ante: { scheme: 'all', amount: ANTE },
    heroHand: 'AA', playersLeft: 4, seats, heroPos: 'CO',
    pot: seats.reduce((a, s) => a + s.bet, 0) + ANTE * 4,
  } as BoardState;
}

describe('pfTable interpolation (4-way / quadlinear)', () => {
  it('中心点は16隅のクアッドリニア平均になる', () => {
    const t = synthTable();
    const r = lookupPf(t, state(15, 15, 15, 15)); // 全軸 f=0.5
    // 16隅の i*1000+j*100+k*10+l の平均。各桁は0/1が均等 → 平均 = 0.5*(1000+100+10+1)=555.5
    expect(r.nodes[0]!.ev['AA']!).toBeCloseTo(555.5, 2);
    expect(r.nodes[0]!.ev['72o']!).toBeCloseTo(-555.5, 2);
    for (const p of ORDER) expect(r.equity[p]!.post).toBeCloseTo(0.5, 3);
  });

  it('格子点そのものは格納値に一致', () => {
    const t = synthTable();
    const r = lookupPf(t, state(20, 10, 20, 10)); // i=1,j=0,k=1,l=0 → 1010
    expect(r.nodes[0]!.ev['AA']!).toBeCloseTo(1010, 2);
  });

  it('1軸だけ中間（他は格子上）＝その軸の線形補間', () => {
    const t = synthTable();
    // CO=15 (f=0.5), 他は上限 → i∈{0,1}平均 + j=1,k=1,l=1 = 500 + 111 = 611
    const r = lookupPf(t, state(15, 20, 20, 20));
    expect(r.nodes[0]!.ev['AA']!).toBeCloseTo(611, 2);
  });

  it('ev>=0 の手だけ push レンジ（ゼロ交差, 純戦略）', () => {
    const t = synthTable();
    const r = lookupPf(t, state(15, 15, 15, 15)); // AA:+555.5(push), 72o:-555.5(fold)
    expect(r.nodes[0]!.hands).toContain('AA');
    expect(r.nodes[0]!.hands).not.toContain('72o');
    expect(r.nodes[0]!.freq['AA']!).toBe(1);
    expect(r.nodes[0]!.freq['72o']!).toBe(0);
  });

  it('カバレッジ: 全席上限以下=in, hero深=heroDeep, 相手深/条件不一致=off（厳密MCへ）', () => {
    const t = synthTable(); // axis [10,20] hi=20, hero=CO
    expect(pfCoverage(t, state(15, 15, 15, 15))).toBe('in');
    // 相手（BB）が上限超 → クランプせず 'off'（厳密 MC へ）。
    expect(pfCoverage(t, state(15, 15, 15, 25))).toBe('off');
    // hero 自身が上限超 → heroDeep（push/fold 対象外）。
    expect(pfCoverage(t, state(25, 15, 15, 15))).toBe('heroDeep');
    expect(pfCoverage(t, state(5, 5, 5, 5))).toBe('in'); // 下限未満はクランプ許容
    // アンティは 0.25 近傍を許容、乖離/別方式は off。
    const near = state(15, 15, 15, 15); (near as { ante: unknown }).ante = { scheme: 'all', amount: 0.2545 };
    expect(pfCoverage(t, near)).toBe('in');
    const noAnte = state(15, 15, 15, 15); (noAnte as { ante: unknown }).ante = { scheme: 'none', amount: 0 };
    expect(pfCoverage(t, noAnte)).toBe('off');
    const s3 = state(15, 15, 15, 15); (s3 as { playersLeft: number }).playersLeft = 3;
    expect(pfCoverage(t, s3)).toBe('off');
    // pfInRange は 'in' のみ true。
    expect(pfInRange(t, state(15, 15, 15, 15))).toBe(true);
    expect(pfInRange(t, state(15, 15, 15, 25))).toBe(false); // 相手深は不可（MCへ）
    expect(pfInRange(t, state(25, 15, 15, 15))).toBe(false);
  });

  it('eqPre はスタックから再計算される（有限値）', () => {
    const t = synthTable();
    const r = lookupPf(t, state(18, 12, 9, 14));
    for (const p of ORDER) expect(Number.isFinite(r.equity[p]!.pre)).toBe(true);
  });

  it('interpExplBound がテーブルの exploitability 表示に反映される', () => {
    const dflt = synthTable();
    expect(lookupPf(dflt, state(15, 15, 15, 15)).exploitabilityPt).toBeCloseTo(0.06, 6); // 既定
    const custom = synthTable(0.1);
    expect(lookupPf(custom, state(15, 15, 15, 15)).exploitabilityPt).toBeCloseTo(0.1, 6);
  });
});
