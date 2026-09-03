/**
 * プロトタイプ（dev専用）: 「答えを丸ごと事前計算して表にする」案の現実性検証。
 * 全条件固定（賞金 +5/+3/+2/+1/0/-1, ante 0.25bb all, blinds 0.5/1）が前提。
 * 変数は「残り人数＋各自スタック(bb)＋ボタン位置」だけ。
 *
 * 測るもの:
 *   (1) 人数ごとの GOLD 求解時間 … オフライン生成コストの元データ
 *   (2) スタック感度 … 1つのスタックを +1/+2/+4bb ずらすと hero のレンジがどれだけ変わるか。
 *       小さいほど表を粗くでき、総サイズが小さくなる（＝現実的）。
 *   (3) 想定グリッドサイズと総生成時間の見積り。
 */

import type { BoardState, Position, SolutionNode } from '@oshihiki/core';
import { positionsForPlayersLeft } from '@oshihiki/core';
import { solveMultiway, maxWorkerCap, type MultiwayNSolveOptions } from '../src/nwaySolver.js';

const log = (s: string): void => void process.stderr.write(s + '\n');
const GOLD = (workers: number): MultiwayNSolveOptions => ({ samples: 80_000, maxIters: 800, refreshEvery: 100, workers });

/** n人・各スタック(bb)・blinds0.5/1・ante0.25all の BoardState。stacks は order 順 (positionsForPlayersLeft)。*/
function stateN(stacks: number[]): BoardState {
  const n = stacks.length;
  const order = positionsForPlayersLeft(n);
  const sb = 0.5, bb = 1, ante = 0.25;
  const seats = order.map((pos, i) => {
    const betBlind = pos === 'SB' ? sb : pos === 'BB' ? bb : 0;
    return { pos, stack: stacks[i]! - betBlind - ante, state: 'live' as const, bet: betBlind };
  });
  return {
    street: 'preflop', blinds: { sb, bb }, ante: { scheme: 'all', amount: ante },
    heroHand: 'KQo', playersLeft: n, seats, heroPos: order[0]!,
    pot: seats.reduce((a, s) => a + s.bet, 0) + ante * n,
  } as BoardState;
}

/** 最初に行動するプレイヤー（order[0], 例:3人ならBTN相当=UTG）の「最初の押し」ノード。 */
function firstInNode(nodes: SolutionNode[], order: Position[]): SolutionNode | undefined {
  return nodes.find((nd) => nd.actor === order[0] && nd.actionType === 'PU');
}

/** 2解の hero-first-in レンジ差（押%差 と 押すハンド集合の食い違い数）。 */
function rangeDiff(a: SolutionNode, b: SolutionNode) {
  const bs = new Set(b.hands);
  const as = new Set(a.hands);
  const miss = a.hands.filter((h) => !bs.has(h)).length + b.hands.filter((h) => !as.has(h)).length;
  return { pctDiff: Math.abs(a.pct - b.pct), handDiff: miss };
}

async function main(): Promise<void> {
  const workers = maxWorkerCap();
  log(`# 事前計算 現実性検証  workers=${workers}\n`);

  // (1) 人数ごとの GOLD 時間
  log('## (1) GOLD 求解時間（人数別 = オフライン1局面あたりのコスト）');
  const times: Record<number, number> = {};
  for (const n of [3, 4]) {
    const base = Array.from({ length: n }, (_, i) => 8 + i * 3); // 適当な非対称スタック
    const t0 = Date.now();
    await solveMultiway(stateN(base), GOLD(workers));
    times[n] = Date.now() - t0;
    log(`  ${n}人: ${(times[n]! / 1000).toFixed(1)}s /局面`);
  }

  // (2) スタック感度（3人）: BTN相当のスタックを動かして first-in レンジの変化を見る
  log('\n## (2) スタック感度（3人, order[0]=先頭席の first-in 押しレンジ）');
  const order3 = positionsForPlayersLeft(3);
  const baseStacks = [10, 12, 8];
  const baseRes = await solveMultiway(stateN(baseStacks), GOLD(workers));
  const baseNode = firstInNode(baseRes.nodes, order3)!;
  log(`  基準 stacks=${baseStacks.join('/')}  first-in 押%=${baseNode.pct.toFixed(1)}`);
  for (const d of [1, 2, 4]) {
    const s = [baseStacks[0]! + d, baseStacks[1]!, baseStacks[2]!];
    const r = await solveMultiway(stateN(s), GOLD(workers));
    const node = firstInNode(r.nodes, order3)!;
    const diff = rangeDiff(baseNode, node);
    log(`  +${d}bb → stacks=${s.join('/')}  押%=${node.pct.toFixed(1)}  Δ押%=${diff.pctDiff.toFixed(1)}pt  レンジ差=${diff.handDiff}手`);
  }

  // (3) グリッドサイズ見積り（レンジ 1..30bb 想定, いくつかの刻み）
  log('\n## (3) グリッド見積り（各スタック 1..30bb と仮定）');
  for (const step of [1, 2, 3]) {
    const levels = Math.floor(30 / step);
    log(`  刻み ${step}bb → 1軸 ${levels}段`);
    for (const n of [3, 4, 5, 6]) {
      const cells = Math.pow(levels, n);
      const t = (times[n] ?? times[4]! * Math.pow(2, n - 4)); // 4人時間から粗く外挿
      const hoursParallel = (cells * t) / 1000 / 3600;
      log(`     ${n}人: ${cells.toLocaleString()} 局面  ≈ 生成 ${hoursParallel.toFixed(hoursParallel < 10 ? 1 : 0)}時間(このPC)`);
    }
  }
}
void main();
