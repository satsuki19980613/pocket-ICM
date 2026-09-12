import { describe, it, expect } from 'vitest';
import type { BoardState } from '@oshihiki/core';
import { payoutsForPlayers } from '../src/icm.js';
import { pfCoverage, buildPfTable, type PfMeta } from '../src/pfTable.js';
import { solveMultiway } from '../src/nwaySolver.js';
import { GAME_MODE_SPECS, positionsForPlayersLeft } from '@oshihiki/core';
import { loadHuWinTieTable } from '../src/huWinTieLoader.js';
import { loadWinTie3Table } from '../src/wintie3Loader.js';

describe('payoutsForPlayers（モード別）', () => {
  it('省略時はクラブ（従来の呼び出しと同じ）', () => {
    expect(payoutsForPlayers(3)).toEqual([5, 3, 2]);
  });

  it('残り n 人は上位 n 着を争う＝先頭 n 個を切り出す', () => {
    expect(payoutsForPlayers(4, 'legend-season')).toEqual([40, 15, 3, 0]);
    expect(payoutsForPlayers(2, 'legend-base')).toEqual([35, 21]);
  });
});

/** 3人・全席 10bb・標準ブラインドの局面。 */
function spot3(gameMode?: BoardState['gameMode']): BoardState {
  return {
    street: 'preflop',
    blinds: { sb: 0.5, bb: 1 },
    ante: { scheme: 'all', amount: 0.25 },
    heroHand: 'A5s',
    playersLeft: 3,
    heroPos: 'BU',
    seats: [
      { pos: 'BU', stack: 9.75, state: 'live', bet: 0 },
      { pos: 'SB', stack: 9.25, state: 'live', bet: 0.5 },
      { pos: 'BB', stack: 8.75, state: 'live', bet: 1 },
    ],
    ...(gameMode ? { gameMode } : {}),
  };
}

describe('事前計算テーブルはクラブ専用', () => {
  // 最小の meta（条件判定にしか使わないので data は空でよい）。
  const meta: PfMeta = {
    kind: 'pf3way',
    blinds: { sb: 0.5, bb: 1 },
    ante: { scheme: 'all', amount: 0.25 },
    order: ['BU', 'SB', 'BB'],
    axis: [2, 6, 10, 14, 18, 22, 25],
    nodeKeys: [],
    nodeActors: [],
    nodeTypes: [],
    classOrder: [],
    stride: 0,
    floatsPerNode: 0,
    samples: 0,
  };
  const table = buildPfTable(meta, new Float32Array(0));

  it('クラブは表で即時に解ける', () => {
    expect(pfCoverage(table, spot3())).toBe('in');
    expect(pfCoverage(table, spot3('club'))).toBe('in');
  });

  it('レジェンドは表を使わず厳密求解へ回す（表はクラブの payout を焼き込んでいるため）', () => {
    for (const m of ['legend-avg', 'legend-season', 'legend-base'] as const) {
      expect(pfCoverage(table, spot3(m))).toBe('off');
    }
  });

  it('hero が深い（>25bb）判定はモード非依存（2026-09-12 の実機検証で見つけた非対称の回帰）', () => {
    // 同じ盤面でクラブだけ「対象外」と出て、ランク/レジェンドは黙って数値を返していた。
    // AOF が最適でなくなる深さはペイアウト構造と無関係な一般則なので、全モードで同じ扱いにする。
    const deep = (mode?: BoardState['gameMode']): BoardState => {
      const st = spot3(mode);
      return {
        ...st,
        seats: st.seats.map((s) => (s.pos === st.heroPos ? { ...s, stack: 30 } : s)),
      };
    };
    expect(pfCoverage(table, deep())).toBe('heroDeep');
    for (const m of ['club', 'rank-3', 'rank-4', 'rank-5', 'legend-avg', 'legend-season', 'legend-base'] as const) {
      expect(pfCoverage(table, deep(m))).toBe('heroDeep');
    }
  });
});

describe('モードが戦略に効く', () => {
  it('クラブとレジェンド（平均）で push レンジが変わる', async () => {
    const opts = { workers: 0, maxIters: 400, samples: 20_000, seed: 7 };
    const club = (await solveMultiway(spot3('club'), opts)) as { nodes: { pct: number }[] };
    const legend = (await solveMultiway(spot3('legend-avg'), opts)) as { nodes: { pct: number }[] };
    expect(club.nodes.length).toBeGreaterThan(0);
    expect(legend.nodes.length).toBe(club.nodes.length);
    // 同一局面・同一シードでも、ペイアウトが別物なので先頭ノードのレンジ幅は一致しない。
    const diff = Math.abs(club.nodes[0]!.pct - legend.nodes[0]!.pct);
    expect(diff).toBeGreaterThan(0.1);
  }, 60_000);
});

describe('ゼロサムのペイアウトでも早期終了が効く', () => {
  it('レジェンドの6人ペイアウトは総和ちょうど 0（しきい値の尺度に総和を使えない）', () => {
    for (const m of ['legend-avg', 'legend-season', 'legend-base'] as const) {
      const sum = GAME_MODE_SPECS[m].payouts.reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(0, 12);
    }
    // クラブは総和が正なので従来どおりの尺度が使える（回帰しないことの明示）。
    expect(GAME_MODE_SPECS.club.payouts.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  it('6人レジェンドが maxIters に張り付かず収束する（総和0で target=0 になるバグの回帰）', async () => {
    const sb = 0.5, bb = 1, ante = 0.25;
    const stacks = [20, 17, 14, 11, 8, 5];
    const order = positionsForPlayersLeft(6);
    const state: BoardState = {
      street: 'preflop',
      blinds: { sb, bb },
      ante: { scheme: 'all', amount: ante },
      heroHand: 'KQo',
      playersLeft: 6,
      heroPos: order[0]!,
      seats: order.map((pos, i) => ({
        pos,
        stack: stacks[i]! - (pos === 'SB' ? sb : pos === 'BB' ? bb : 0) - ante,
        state: 'live' as const,
        bet: pos === 'SB' ? sb : pos === 'BB' ? bb : 0,
      })),
      gameMode: 'legend-avg',
    };
    // アプリの求解 Worker と同じく win/tie テーブルを渡す（ショーダウンが厳密になり
    // MC ノイズ床が消えるので、しきい値どおりに早期終了できる条件になる）。
    const maxIters = 3000;
    const r = await solveMultiway(state, {
      workers: 0, maxIters, samples: 24_000, avgPower: 1,
      winTie: loadHuWinTieTable(), winTie3: loadWinTie3Table(),
    });
    expect(r.converged).toBe(true);
    expect(r.iterations).toBeLessThan(maxIters);
  }, 120_000);
});
