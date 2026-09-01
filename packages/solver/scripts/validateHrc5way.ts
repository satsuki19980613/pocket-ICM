/**
 * 実 HRC 5-way 参照データとの照合レポート（M4 / IMPLEMENTATION_PLAN §4.2-4.3）。
 *
 * 入力: packages/harness/cases/_reference-hrc-5way-blinds05-1-025.json
 *   （さつき収集の実 HRC 値。UTG/CO/BU/SB/BB = 10/20/30/23/12bb, blinds 0.5/1,
 *    ante all 0.25, prizes 実払い +5/+3/+2/+1/0 = シフト形 6/4/3/2/1 / プール16）
 *
 * 出力（stderr, 人間可読）:
 *   1. EQPre / EQPost の pct 照合（HRC vs 自作, 差）
 *   2. 各戦略ノードの freq% とレンジ集合の照合（欠落/余剰ハンド）
 *
 * 実行:
 *   OSHIHIKI_WORKERS=16 node --import tsx packages/solver/scripts/validateHrc5way.ts
 *
 * §2.2 換算: 自作ソルバーは実払い pt（[5,3,2,1,0]）。HRC はシフト形 [6,4,3,2,1]。
 * 全 payout の +1 シフトは各席 equity を +1 する（Σ着順確率=1）ため
 *   pct_shifted = (real_pt + 1) / 16 * 100。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { BoardState, Position } from '@oshihiki/core';
import { positionsForPlayersLeft, normalizeKey, parseRangeToSet } from '@oshihiki/core';
import type { ActionChar } from '@oshihiki/core';
import { solveMultiway, maxWorkerCap } from '../src/nwaySolver.js';

const log = (s: string): void => void process.stderr.write(s + '\n');
const HERE = dirname(fileURLToPath(import.meta.url));
const REF = join(HERE, '..', '..', 'harness', 'cases', '_reference-hrc-5way-blinds05-1-025.json');

interface RefStrategy {
  actor: Position;
  vs?: string;
  type: 'PU' | 'CA' | 'OC';
  freqPct: number;
  range: string;
}
interface RefPlayer {
  pos: Position;
  stack: number;
  eqPrePct: number;
  eqPostPct: number;
}
interface RefFile {
  setup: { blinds: { sb: number; bb: number }; ante: { scheme: string; amount: number }; poolPt: number };
  players: RefPlayer[];
  strategies: RefStrategy[];
}

/** HRC エントリ → §3.2 正規キー。 */
function keyOf(order: Position[], s: RefStrategy): string {
  const aggressors = s.vs ? s.vs.split(',').map((x) => x.trim()) : [];
  const actions: Partial<Record<Position, ActionChar>> = {};
  const ai = order.indexOf(s.actor);
  for (let j = 0; j < ai; j++) {
    const p = order[j]!;
    if (aggressors.includes(p)) actions[p] = p === aggressors[0] ? 'P' : 'C';
    else actions[p] = 'F';
  }
  return normalizeKey(order.length, actions);
}

/** HRC の "stack"（総チップ=T）から §3.1 の seat（stack=bet 差引後）を復元。 */
function buildState(ref: RefFile): BoardState {
  const { sb, bb } = ref.setup.blinds;
  const ante = ref.setup.ante.amount;
  const seats = ref.players.map((p) => {
    const bet = p.pos === 'SB' ? sb : p.pos === 'BB' ? bb : 0;
    return { pos: p.pos, stack: p.stack - bet - ante, state: 'live' as const, bet };
  });
  const potBets = seats.reduce((a, s) => a + s.bet, 0);
  return {
    street: 'preflop',
    blinds: { sb, bb },
    ante: { scheme: 'all', amount: ante },
    heroHand: 'KQo',
    playersLeft: 5,
    seats,
    heroPos: 'UTG',
    pot: potBets + ante * seats.length,
  } as BoardState;
}

async function main(): Promise<void> {
  const ref = JSON.parse(readFileSync(REF, 'utf8')) as RefFile;
  const order = positionsForPlayersLeft(5);
  const state = buildState(ref);

  const workers = maxWorkerCap();
  // OSHIHIKI_CARD_REMOVAL=1 で hero カードリムーバル補正（M5 実験, docs §5）を有効化。
  // 既定は card-blind（M4 検証済みベースライン）。
  const cardRemoval = process.env.OSHIHIKI_CARD_REMOVAL === '1';
  log(`# 実 HRC 5-way 照合  (workers=${workers}, cardRemoval=${cardRemoval})`);
  log(`node ${process.version}\n`);

  const t0 = Number(process.hrtime.bigint() / 1000000n);
  const res = await solveMultiway(state, { maxIters: 800, refreshEvery: 100, samples: 80_000, workers, cardRemoval });
  const ms = Number(process.hrtime.bigint() / 1000000n) - t0;
  log(
    `求解: ${(ms / 1000).toFixed(1)}s  iters=${res.iterations}  ` +
      `expl=${res.exploitabilityPt.toFixed(4)}pt  converged=${res.converged}\n`,
  );

  // --- 1. EQ 照合 ---
  const toShiftedPct = (realPt: number): number => ((realPt + 1) / ref.setup.poolPt) * 100;
  log('## EQPre / EQPost（pct, シフト形換算）');
  log('  pos   EQPre(HRC/自作/差)        EQPost(HRC/自作/差)');
  for (const p of ref.players) {
    const e = res.equity[p.pos]!;
    const prePct = toShiftedPct(e.pre);
    const postPct = toShiftedPct(e.post);
    log(
      `  ${p.pos.padEnd(4)} ${p.eqPrePct.toFixed(2)}/${prePct.toFixed(2)}/${(prePct - p.eqPrePct).toFixed(2).padStart(6)}` +
        `     ${p.eqPostPct.toFixed(2)}/${postPct.toFixed(2)}/${(postPct - p.eqPostPct).toFixed(2).padStart(6)}`,
    );
  }

  // --- 2. 戦略照合 ---
  const byKey = Object.fromEntries(res.nodes.map((n) => [n.key, n]));
  log('\n## 戦略ノード（HRC freq% vs 自作 freq%, レンジ差）');
  log('  actor vs                type  HRC%  自作%   欠落(HRCのみ) / 余剰(自作のみ)');
  let freqAbsSum = 0;
  let cnt = 0;
  for (const s of ref.strategies) {
    const key = keyOf(order, s);
    const node = byKey[key];
    if (!node) {
      log(`  ${s.actor} vs=${s.vs ?? '-'} [${s.type}] → キー ${key} が解に無い`);
      continue;
    }
    const hrcSet = parseRangeToSet(s.range);
    const mySet = new Set(node.hands);
    const missing = [...hrcSet].filter((h) => !mySet.has(h));
    const extra = [...mySet].filter((h) => !hrcSet.has(h));
    freqAbsSum += Math.abs(node.pct - s.freqPct);
    cnt++;
    const vs = (s.vs ?? '-').padEnd(10);
    log(
      `  ${s.actor.padEnd(4)} ${vs} ${s.type}  ${s.freqPct.toFixed(1).padStart(5)} ${node.pct.toFixed(1).padStart(5)}` +
        `   -${missing.length}/+${extra.length}` +
        (missing.length + extra.length <= 8 && missing.length + extra.length > 0
          ? `  [${missing.map((h) => '-' + h).concat(extra.map((h) => '+' + h)).join(' ')}]`
          : ''),
    );
  }
  log(`\n  平均 |freq% 差| = ${(freqAbsSum / cnt).toFixed(2)}pt（§4.3 目安 ±0.5, 境界ハンド差は許容）`);
}

void main();
