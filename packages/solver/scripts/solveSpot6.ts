/**
 * 指定6人局面を「速い設定」で解いて、時間と全ノードの押し/コールレンジを出力する。
 * さつき指定: UTG9.7 HJ15.7 CO17.8 BTN15.9 SB17.3 BB5.3 bb, blinds0.5/1, ante0.25(all).
 * HRC nashicm との1手ずつ照合用。
 */

import type { BoardState, Position } from '@oshihiki/core';
import { solveMultiway, maxWorkerCap } from '../src/nwaySolver.js';

const log = (s: string): void => void process.stderr.write(s + '\n');

const STACKS: Record<string, number> = { UTG: 9.7, HJ: 15.7, CO: 17.8, BU: 15.9, SB: 17.3, BB: 5.3 };

function buildSpot(): BoardState {
  const sb = 0.5, bb = 1, ante = 0.25;
  const seats = (Object.keys(STACKS) as Position[]).map((pos) => {
    const betBlind = pos === 'SB' ? sb : pos === 'BB' ? bb : 0;
    return { pos, stack: STACKS[pos]! - betBlind - ante, state: 'live' as const, bet: betBlind };
  });
  return {
    street: 'preflop', blinds: { sb, bb }, ante: { scheme: 'all', amount: ante },
    heroHand: 'KQo', playersLeft: 6, seats, heroPos: 'CO',
    pot: seats.reduce((a, s) => a + s.bet, 0) + ante * 6,
  } as BoardState;
}

async function main(): Promise<void> {
  const workers = maxWorkerCap();
  const state = buildSpot();
  log(`# 6人局面 速い設定で求解  workers=${workers}`);
  log(`  UTG9.7 HJ15.7 CO17.8 BTN15.9 SB17.3 BB5.3 / blinds0.5-1 / ante0.25 all / payout +5+3+2+1 0 -1\n`);

  const t0 = Number(process.hrtime.bigint() / 1000000n);
  const res = await solveMultiway(state, { samples: 5_000, maxIters: 250, refreshEvery: 100, workers });
  const ms = Number(process.hrtime.bigint() / 1000000n) - t0;

  log(`■ 計算時間: ${(ms / 1000).toFixed(1)}秒 (このPC ${workers}並列)  iters=${res.iterations} conv=${res.converged} expl=${res.exploitabilityPt.toFixed(4)}`);
  log(`  ※さつき端末は約3.4倍 → 推定 約${(ms / 1000 * 3.4).toFixed(0)}秒\n`);

  log('■ 各ポジションの押し/コール レンジ（押%＝そのアクションを取るコンボ比）');
  log('  行動者  状況(vs)         種類  押%    レンジ');
  const typeJa: Record<string, string> = { PU: '最初押', CA: 'コール', OC: '再コール' };
  // vs の再構成: key から前方アグレッサーを読む（P=最初の押し, C=コール）。表示は素朴に key を添える。
  for (const n of res.nodes) {
    const vs = n.key.length > 0 ? n.key : '-';
    log(
      `  ${n.actor.padEnd(4)} ${vs.padEnd(16)} ${typeJa[n.actionType]}  ${n.pct.toFixed(1).padStart(5)}  ${n.range}`,
    );
  }

  log('\n■ 各席の ICM equity（実払いpt: 局面前→局面後）');
  for (const [pos, e] of Object.entries(res.equity)) {
    log(`  ${pos.padEnd(4)} ${e.pre.toFixed(3)} → ${e.post.toFixed(3)}`);
  }
}
void main();
