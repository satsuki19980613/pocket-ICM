/**
 * プロトタイプ（dev専用）: 6-max（さつきの実際の痛点）で「速いMC」案の速度・安定性を測る。
 *
 * 6-max の実 HRC 正解データは未収集のため、精度は「高サンプルの自己ゴールド」に対する
 * レンジ頻度のブレ（平均/最大 |freq% 差|）で見る。速度は絶対秒 + ゴールド比。
 * ※絶対秒はこのマシン（多コア）依存。さつき端末の体感は「速度比 × 現状体感(~2分)」で外挿する。
 */

import type { BoardState } from '@oshihiki/core';
import { solveMultiway, maxWorkerCap, type MultiwayNSolveOptions } from '../src/nwaySolver.js';

const log = (s: string): void => void process.stderr.write(s + '\n');

/** 代表的な 6-max 局面（10/15/20/25/12/8 bb 相当, blinds 0.5/1, ante all 0.1）。 */
function state6(): BoardState {
  const sb = 0.5, bb = 1, ante = 0.1;
  const chips = [10, 15, 20, 25, 12, 8]; // UTG..BB の総チップ(T)
  const order = ['UTG', 'HJ', 'CO', 'BU', 'SB', 'BB'] as const;
  const seats = order.map((pos, i) => {
    const bet = pos === 'SB' ? sb : pos === 'BB' ? bb : 0;
    return { pos, stack: chips[i]! - bet - ante, state: 'live' as const, bet };
  });
  return {
    street: 'preflop', blinds: { sb, bb }, ante: { scheme: 'all', amount: ante },
    heroHand: 'KQo', playersLeft: 6, seats, heroPos: 'CO',
    pot: seats.reduce((a, s) => a + s.bet, 0) + ante * seats.length,
  } as BoardState;
}

async function solveTimed(state: BoardState, opts: MultiwayNSolveOptions) {
  const t0 = Number(process.hrtime.bigint() / 1000000n);
  const res = await solveMultiway(state, opts);
  const ms = Number(process.hrtime.bigint() / 1000000n) - t0;
  return { res, ms };
}

/** 2 解のノード頻度差（平均/最大 pct）。共通キーで比較。 */
function freqDiff(a: { nodes: { key: string; pct: number }[] }, b: { nodes: { key: string; pct: number }[] }) {
  const bMap = new Map(b.nodes.map((n) => [n.key, n.pct]));
  let sum = 0, max = 0, cnt = 0;
  for (const n of a.nodes) {
    const other = bMap.get(n.key);
    if (other === undefined) continue;
    const d = Math.abs(n.pct - other);
    sum += d; max = Math.max(max, d); cnt++;
  }
  return { avg: sum / cnt, max };
}

async function main(): Promise<void> {
  const state = state6();
  const workers = maxWorkerCap();
  log(`# 6-max「速いMC」案 プロトタイプ（速度・安定性）`);
  log(`node ${process.version}  workers=${workers}\n`);

  // 自己ゴールド（高サンプル・多反復）。
  log('自己ゴールド 60k/700 を計算中...');
  const gold = await solveTimed(state, { samples: 60_000, maxIters: 700, refreshEvery: 100, workers });
  log(`  gold: ${(gold.ms / 1000).toFixed(1)}s iters=${gold.res.iterations} conv=${gold.res.converged} expl=${gold.res.exploitabilityPt.toFixed(4)}\n`);

  const configs: { name: string; opts: MultiwayNSolveOptions }[] = [
    { name: 'App現行 24k/500', opts: { samples: 24_000, maxIters: 500, refreshEvery: 100, workers } },
    { name: 'fast1  12k/400 ', opts: { samples: 12_000, maxIters: 400, refreshEvery: 100, workers } },
    { name: 'fast2   8k/300 ', opts: { samples: 8_000, maxIters: 300, refreshEvery: 100, workers } },
    { name: 'fast3   5k/250 ', opts: { samples: 5_000, maxIters: 250, refreshEvery: 100, workers } },
  ];

  const rows = [];
  for (const cfg of configs) {
    const { res, ms } = await solveTimed(state, cfg.opts);
    const d = freqDiff(res, gold.res);
    rows.push({ name: cfg.name, ms, iters: res.iterations, conv: res.converged, expl: res.exploitabilityPt, ...d });
    log(
      `${cfg.name} | ${(ms / 1000).toFixed(1).padStart(6)}s | iters ${String(res.iterations).padStart(3)} conv=${res.converged ? 'Y' : 'n'} | ` +
        `expl ${res.exploitabilityPt.toFixed(4)} | gold比 平均|freq%| ${d.avg.toFixed(2)}pt 最大 ${d.max.toFixed(1)}pt`,
    );
  }

  log(`\n## 速度比（現行 App 24k/500 比）と安定性`);
  const base = rows[0]!;
  for (const r of rows) {
    log(`  ${r.name}: ${(base.ms / r.ms).toFixed(1)}x  gold比 平均|freq%|=${r.avg.toFixed(2)}pt`);
  }
}

void main();
