import { describe, it, expect } from 'vitest';
import type { BoardState } from '@oshihiki/core';
import { positionsForPlayersLeft } from '@oshihiki/core';
import {
  computeShowdown3Exact,
  computeShowdown3ExactForceSparse,
  computeShowdown3ExactForceDense,
  computeShowdown3ExactDenseChunk,
  mergeShowdown3ExactDenseChunks,
} from '../src/showdownExact.js';
import { MapWinTie3Table, buildWinTie3Table, type WinTie3Entry } from '../src/wintie3Table.js';
import { winTie3ArtifactExists, loadWinTie3Table } from '../src/wintie3Loader.js';
import { N_TRIPLES3, PATTERNS, sortedTripleIndex } from '../src/wintie3Index.js';
import { mcTriple } from '../scripts/gen3wayOutcomeTable.js';
import { HAND_CLASS_ORDER, HAND_CLASS_INDEX, handClassToCombos } from '../src/huEquity.js';
import { DeterministicRng } from '../src/placement.js';
import { icmEquities, payoutsForPlayers } from '../src/icm.js';
import { finalStacksFromShowdown } from '../src/sidepot.js';
import { estimateNodeEquities, type ShowdownNode } from '../src/showdownMc.js';
import { loadHuWinTieTable, type WinTieTable } from '../src/huWinTieLoader.js';
import { solveMultiway } from '../src/nwaySolver.js';

const TIMEOUT = 60_000;
const N_CLASSES = 169;

function rangeOf(...classes: number[]): Float64Array {
  const r = new Float64Array(N_CLASSES);
  for (const c of classes) r[c] = 1;
  return r;
}

function expectArraysClose(a: ArrayLike<number>, b: ArrayLike<number>, digits = 9): void {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) expect(a[i]).toBeCloseTo(b[i]!, digits);
}

// ============================================================================
// (a) MC(mcTriple)で作った部分テーブル vs legacy MC(estimateNodeEquities) との整合
// ============================================================================

describe('computeShowdown3Exact — mcTriple 製の部分テーブルと legacy MC の整合', () => {
  const iAA = HAND_CLASS_INDEX['AA']!;
  const iKK = HAND_CLASS_INDEX['KK']!;
  const iQQ = HAND_CLASS_INDEX['QQ']!;
  const iJJ = HAND_CLASS_INDEX['JJ']!;

  const r0 = rangeOf(iAA, iKK); // participant0 の到達レンジ
  const r1 = rangeOf(iKK, iQQ); // participant1
  const r2 = rangeOf(iQQ, iJJ); // participant2

  // {AA,KK}×{KK,QQ}×{QQ,JJ} の 8 通り（ソート後の重複は1回だけ）を 200,000 本の MC で埋める。
  const entries = new Map<number, WinTie3Entry>();
  for (const a of [iAA, iKK]) {
    for (const b of [iKK, iQQ]) {
      for (const c of [iQQ, iJJ]) {
        const sorted = [a, b, c].sort((x, y) => x - y);
        const [s0, s1, s2] = sorted as [number, number, number];
        const idx = sortedTripleIndex(s0, s1, s2);
        if (entries.has(idx)) continue;
        const rng = new DeterministicRng(0xabc123 ^ idx);
        const { probs12, validCount } = mcTriple(s0, s1, s2, 200_000, rng);
        const probs13 = new Float64Array(13);
        let sum = 0;
        for (let n = 0; n < 12; n++) {
          probs13[n] = probs12[n]!;
          sum += probs12[n]!;
        }
        probs13[12] = Math.max(0, 1 - sum);
        entries.set(idx, { probs13, valid: validCount });
      }
    }
  }
  const table = new MapWinTie3Table(entries);

  const node: ShowdownNode = {
    preHandStacks: [20, 20, 20],
    commits: [20, 20, 20],
    participants: [0, 1, 2],
    payouts: payoutsForPlayers(3),
  };
  const ranges = [r0, r1, r2];

  it('pcEq: 各参加者の実レンジ内クラスで legacy MC(40万本) と 0.01pt 以内', () => {
    const exact = computeShowdown3Exact(node, ranges, table);
    const rng = new DeterministicRng(0x1357);
    const mc = estimateNodeEquities(node, ranges, 400_000, rng);

    const checks: [number, number][] = [
      [0, iAA],
      [0, iKK],
      [1, iKK],
      [1, iQQ],
      [2, iQQ],
      [2, iJJ],
    ];
    for (const [p, c] of checks) {
      const diff = Math.abs(exact.pcEq[p]![c]! - mc.eq[p]![c]!);
      expect(diff).toBeLessThan(0.01);
    }
  });

  it('seatMarginal: legacy MC(40万本) と 0.01pt 以内・payout 保存', () => {
    const exact = computeShowdown3Exact(node, ranges, table);
    const rng = new DeterministicRng(0x2024);
    const mc = estimateNodeEquities(node, ranges, 400_000, rng);
    for (let s = 0; s < 3; s++) {
      expect(Math.abs(exact.seatMarginal[s]! - mc.seatMarginal[s]!)).toBeLessThan(0.01);
    }
    const sum = exact.seatMarginal.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(payoutsForPlayers(3).reduce((a, b) => a + b, 0), 5);
  });

  // ============================================================================
  // (b) 参加者順の入れ替えに対する一貫性（同一物理状況は同じ結果を返す）
  // ============================================================================
  it('参加者順を入れ替えても（席への写像を保てば）同じ結果になる', () => {
    const resultA = computeShowdown3Exact(node, [r0, r1, r2], table);

    // 同じ 3 席・同じ状況を participants=[1,2,0] という別の並びで記述する。
    const node2: ShowdownNode = { ...node, participants: [1, 2, 0] };
    const resultB = computeShowdown3Exact(node2, [r1, r2, r0], table);

    // 席0の pcEq は node の位置0・node2 の位置2 に対応。
    // 浮動小数の加算順序が異なる（ループの回り方が変わる）ため厳密な bit 一致は求めず、
    // 実用上の誤差（真のバグなら 1e-2〜数 pt 級のズレになる）より十分小さい桁で比較する。
    expectArraysClose(resultA.pcEq[0]!, resultB.pcEq[2]!, 3);
    expectArraysClose(resultA.pcEq[1]!, resultB.pcEq[0]!, 3);
    expectArraysClose(resultA.pcEq[2]!, resultB.pcEq[1]!, 3);
    // seatMarginal は席インデックスで表現されるので並び替えの影響を受けない。
    expectArraysClose(resultA.seatMarginal, resultB.seatMarginal, 3);
  });

  // ============================================================================
  // (d) part B: ε-pruning（EPS_ARRIVAL=1e-3）の近似誤差が小さいことの実測
  // ============================================================================
  it('ε-pruning: 5e-4 の微小クラスを混ぜても pcEq[0] の変化は 0.002pt 未満', () => {
    // FP 平均戦略の decay 末尾を模して、r1/r2 に「本来の到達クラス」＋「重み 5e-4 の
    // 微小クラス」を混在させる。5e-4 < EPS_ARRIVAL(1e-3) なので computeShowdown3Exact の
    // 内部では枝刈りされ、無視される（下記 naivePcEq0 は枝刈りしない素朴な参照実装）。
    const r1tiny = rangeOf(iKK);
    r1tiny[iQQ] = 5e-4;
    const r2tiny = rangeOf(iQQ);
    r2tiny[iJJ] = 5e-4;

    const pruned = computeShowdown3Exact(node, [r0, r1tiny, r2tiny], table);
    const naive = naivePcEq0(node, [r0, r1tiny, r2tiny], table);

    for (const c of [iAA, iKK]) {
      const diff = Math.abs(pruned.pcEq[0]![c]! - naive[c]!);
      expect(diff).toBeLessThan(0.002);
    }
  });
});

/** [p0,p1,p2] の dense rank パターン → strongerCount（showdownExact.ts の
 * denseToStrongerCount と等価な変換。テスト用に独立実装して結合度を下げる）。 */
function denseToStrongerCountForTest(pattern: readonly [number, number, number]): [number, number, number] {
  const cnt = [0, 0, 0];
  for (const d of pattern) cnt[d]!++;
  const out: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    let s = 0;
    for (let v = 0; v < pattern[i]!; v++) s += cnt[v]!;
    out[i] = s;
  }
  return out;
}

/**
 * computeShowdown3Exact の pcEq[0]（hero=participants[0]）と数学的に等価だが、
 * ε-pruning を一切行わない素朴な参照実装（169×169 の全ペアを毎回舐める）。
 * ε-pruning が導入する誤差だけを単離して測るためのテスト専用ヘルパー。
 */
function naivePcEq0(
  node: ShowdownNode,
  ranges: readonly Float64Array[],
  table: MapWinTie3Table,
): Float64Array {
  const [p0, p1, p2] = node.participants as readonly [number, number, number];
  const n = node.preHandStacks.length;
  const eligible = new Array<boolean>(n).fill(false);
  eligible[p0] = true;
  eligible[p1] = true;
  eligible[p2] = true;
  const outcomeVecs = PATTERNS.map((pat) => {
    const [s0, s1, s2] = denseToStrongerCountForTest(pat);
    const sc = new Array<number>(n).fill(0);
    sc[p0] = s0;
    sc[p1] = s1;
    sc[p2] = s2;
    return icmEquities(finalStacksFromShowdown(node.preHandStacks, node.commits, eligible, sc), node.payouts, node.preHandStacks);
  });
  const r1 = ranges[1]!, r2 = ranges[2]!;
  const out = new Float64Array(PATTERNS.length);
  const pcEq0 = new Float64Array(N_CLASSES);
  for (let c = 0; c < N_CLASSES; c++) {
    let s = 0, wsum = 0;
    for (let cb = 0; cb < N_CLASSES; cb++) {
      const wb = r1[cb]!;
      if (wb <= 0) continue;
      for (let cc = 0; cc < N_CLASSES; cc++) {
        const wc = r2[cc]!;
        if (wc <= 0) continue;
        const validCount = table.lookup(c, cb, cc, out);
        const w = wb * wc * validCount;
        if (w === 0) continue;
        wsum += w;
        for (let nn = 0; nn < PATTERNS.length; nn++) s += w * out[nn]! * outcomeVecs[nn]![p0]!;
      }
    }
    pcEq0[c] = wsum > 0 ? s / wsum : 0;
  }
  return pcEq0;
}

// ============================================================================
// (c) 合成フルテーブルでの solveMultiway 動作確認（決定性・有限な exploitability）
// ============================================================================

/**
 * HU 勝ち/引き分け表から Plackett-Luce モデルで 3-way の 13 パターン確率を近似し、
 * 818,805 三つ組**全て**を埋めた「妥当だがモック」の wintie3 テーブルを作る
 * （厳密な MC 生成は 2 時間かかるため、テストでは代用）。
 * 各クラスの「フルレンジに対する平均 equity」を強さスコアとし、Luce の選択公理で
 * 3人の着順分布を作る（同着確率は含めない＝簡略化, 合計は概ね1に正規化される）。
 */
function buildSyntheticWinTie3(winTie: WinTieTable): { u16: Uint16Array; meta: { dims: number; nTriples: number } } {
  const N = N_CLASSES;
  const score = new Float64Array(N);
  for (let c = 0; c < N; c++) {
    let s = 0;
    for (let d = 0; d < N; d++) s += winTie.win[c * N + d]! + winTie.tie[c * N + d]! / 2;
    score[c] = Math.max(s / N, 1e-6);
  }
  const comboOf = HAND_CLASS_ORDER.map((l) => handClassToCombos(l).length);
  const u16 = new Uint16Array(N_TRIPLES3 * 13);
  let idx = 0;
  for (let c1 = 0; c1 < N; c1++) {
    for (let c2 = c1; c2 < N; c2++) {
      for (let c3 = c2; c3 < N; c3++) {
        const r0 = score[c1]!, r1 = score[c2]!, r2 = score[c3]!;
        const sum = r0 + r1 + r2;
        // Plackett-Luce: P(1位,2位,3位 の順) = r_1位/(合計) * r_2位/(2位+3位の合計)。
        const p012 = (r0 / sum) * (r1 / (r1 + r2)); // slot0>slot1>slot2
        const p021 = (r0 / sum) * (r2 / (r1 + r2)); // slot0>slot2>slot1
        const p102 = (r1 / sum) * (r0 / (r0 + r2)); // slot1>slot0>slot2
        const p120 = (r1 / sum) * (r2 / (r0 + r2)); // slot1>slot2>slot0
        const p201 = (r2 / sum) * (r0 / (r0 + r1)); // slot2>slot0>slot1
        const p210 = (r2 / sum) * (r1 / (r0 + r1)); // slot2>slot1>slot0
        const probs12 = [p012, p021, p102, p120, p201, p210, 0, 0, 0, 0, 0, 0];
        const base = idx * 13;
        for (let n = 0; n < 12; n++) {
          u16[base + n] = Math.max(0, Math.min(65535, Math.round(probs12[n]! * 65535)));
        }
        u16[base + 12] = Math.min(1728, comboOf[c1]! * comboOf[c2]! * comboOf[c3]!);
        idx++;
      }
    }
  }
  return { u16, meta: { dims: N, nTriples: N_TRIPLES3 } };
}

function equalStacks(n: number, stack: number, sb = 0.5, bb = 1.0): BoardState {
  const order = positionsForPlayersLeft(n);
  const seats = order.map((pos) => {
    const bet = pos === 'SB' ? sb : pos === 'BB' ? bb : 0;
    return { pos, stack: stack - bet, state: 'live' as const, bet };
  });
  return {
    street: 'preflop',
    blinds: { sb, bb },
    ante: { scheme: 'none', amount: 0 },
    heroHand: 'KQo',
    playersLeft: n,
    seats,
    heroPos: order[0]!,
    pot: sb + bb,
  } as BoardState;
}

describe('solveMultiway — winTie3（合成フルテーブル）経由の 3 人ショーダウン厳密化', () => {
  const winTie = loadHuWinTieTable();
  const { u16, meta } = buildSyntheticWinTie3(winTie);
  const winTie3 = buildWinTie3Table(u16, meta);
  const state = equalStacks(3, 12);
  const opts = { maxIters: 150, refreshEvery: 50, samples: 4000, seed: 7, workers: 0, winTie, winTie3 } as const;

  it(
    '求解が完了し、同一シードで決定的（bit一致）、exploitability は有限かつ小さい',
    async () => {
      const res1 = await solveMultiway(state, opts);
      const res2 = await solveMultiway(state, opts);

      expect(res1.iterations).toBe(res2.iterations);
      expect(res1.exploitabilityPt).toBe(res2.exploitabilityPt);
      for (let i = 0; i < res1.nodes.length; i++) {
        expect(res1.nodes[i]!.freq).toEqual(res2.nodes[i]!.freq);
        expect(res1.nodes[i]!.range).toBe(res2.nodes[i]!.range);
      }

      expect(Number.isFinite(res1.exploitabilityPt)).toBe(true);
      const poolPt = payoutsForPlayers(3).reduce((a, b) => a + b, 0);
      expect(res1.exploitabilityPt).toBeGreaterThanOrEqual(0);
      expect(res1.exploitabilityPt).toBeLessThan(poolPt * 0.1);

      const sumPost = Object.values(res1.equity).reduce((s, e) => s + e.post, 0);
      expect(sumPost).toBeCloseTo(poolPt, 5);
    },
    TIMEOUT,
  );
});

// ============================================================================
// dense（single-sweep）パス vs sparse パスの数値一致（実テーブル使用, 無ければ skip）。
// ============================================================================

/** レンジ幅 frac（0..1）の「先頭 k クラスを 1、残りを 0」のレンジを作る（各種の幅を試すため）。 */
function widthRange(frac: number, offset = 0): Float64Array {
  const r = new Float64Array(N_CLASSES);
  const k = Math.round(N_CLASSES * frac);
  for (let i = 0; i < k; i++) r[(i + offset) % N_CLASSES] = 1;
  return r;
}

(winTie3ArtifactExists() ? describe : describe.skip)(
  'computeShowdown3Exact — dense（single-sweep）パスと sparse パスの数値一致（実テーブル）',
  () => {
    const table = loadWinTie3Table();
    const node: ShowdownNode = {
      preHandStacks: [30, 25, 20],
      commits: [30, 25, 20],
      participants: [0, 1, 2],
      payouts: payoutsForPlayers(3),
    };

    function checkPair(label: string, ranges: Float64Array[]): void {
      it(`${label}: dense と sparse は pcEq/seatMarginal が 1e-9 以内で一致`, () => {
        const sparse = computeShowdown3ExactForceSparse(node, ranges, table);
        const dense = computeShowdown3ExactForceDense(node, ranges, table);
        for (let p = 0; p < 3; p++) {
          expectArraysClose(sparse.pcEq[p]!, dense.pcEq[p]!, 9);
        }
        expectArraysClose(sparse.seatMarginal, dense.seatMarginal, 9);
      });
    }

    // 各種の幅（狭い・中間・広い・フル）を組み合わせる。フル×フル×フルが最も dense。
    checkPair('full × full × full', [widthRange(1), widthRange(1), widthRange(1)]);
    checkPair('90% × 70% × 50%', [widthRange(0.9), widthRange(0.7, 5), widthRange(0.5, 17)]);
    checkPair('60% × 60% × 60%', [widthRange(0.6, 3), widthRange(0.6, 41), widthRange(0.6, 89)]);
    checkPair('狭い×狭い×広い（AA/KK vs KK/QQ vs full）', [
      widthRange(0.012), // ≈2クラス
      widthRange(0.012, 1),
      widthRange(1),
    ]);

    it('computeShowdown3Exact の自動振り分けは full×full×full で dense と一致する（dispatch 検証）', () => {
      const ranges = [widthRange(1), widthRange(1), widthRange(1)];
      const auto = computeShowdown3Exact(node, ranges, table);
      const dense = computeShowdown3ExactForceDense(node, ranges, table);
      for (let p = 0; p < 3; p++) expectArraysClose(auto.pcEq[p]!, dense.pcEq[p]!, 12);
      expectArraysClose(auto.seatMarginal, dense.seatMarginal, 12);
    });

    // ========================================================================
    // item1: dense sweep の 'a' 範囲チャンク分割（worker 並列化用）が whole-set dense と一致。
    // ========================================================================
    function checkChunked(label: string, ranges: Float64Array[], nchunks: number): void {
      it(`${label}: ${nchunks} チャンクに分割して merge した結果は whole-set dense と一致`, () => {
        const whole = computeShowdown3ExactForceDense(node, ranges, table);
        const bounds: { lo: number; hi: number }[] = [];
        let lo = 0;
        for (let i = 0; i < nchunks; i++) {
          const hi = Math.round(((i + 1) * N_CLASSES) / nchunks);
          if (hi > lo) bounds.push({ lo, hi });
          lo = hi;
        }
        const chunks = bounds.map((b) => computeShowdown3ExactDenseChunk(node, ranges, table, b.lo, b.hi));
        const merged = mergeShowdown3ExactDenseChunks(node, chunks);
        for (let p = 0; p < 3; p++) expectArraysClose(whole.pcEq[p]!, merged.pcEq[p]!, 9);
        expectArraysClose(whole.seatMarginal, merged.seatMarginal, 9);
      });
    }

    // 1 チャンク（=EXACT3_NCHUNKS<=1 のときの経路）は加算順序が変わらないので bit 一致のはず。
    it('1 チャンク（[0,169) のみ）は whole-set dense と bit 一致', () => {
      const ranges = [widthRange(1), widthRange(1), widthRange(1)];
      const whole = computeShowdown3ExactForceDense(node, ranges, table);
      const chunk = computeShowdown3ExactDenseChunk(node, ranges, table, 0, N_CLASSES);
      const merged = mergeShowdown3ExactDenseChunks(node, [chunk]);
      for (let p = 0; p < 3; p++) {
        expect(Array.from(merged.pcEq[p]!)).toEqual(Array.from(whole.pcEq[p]!));
      }
      expect(merged.seatMarginal).toEqual(whole.seatMarginal);
    });

    checkChunked('full × full × full', [widthRange(1), widthRange(1), widthRange(1)], 8);
    checkChunked('90% × 70% × 50%', [widthRange(0.9), widthRange(0.7, 5), widthRange(0.5, 17)], 4);
    checkChunked('狭い×狭い×広い（AA/KK vs KK/QQ vs full）', [widthRange(0.012), widthRange(0.012, 1), widthRange(1)], 3);
  },
);
