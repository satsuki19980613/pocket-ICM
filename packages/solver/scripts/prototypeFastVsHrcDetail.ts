/**
 * プロトタイプ（dev専用）: 「一番速い設定」の出力を、実 HRC 5-way 正解と 1手ずつ並べる詳細比較。
 * さつき提案「速い設定 vs HRC を実際に見て、許容範囲なら採用」を実データで実行する。
 * 各戦略ノードで HRC の押し%・自作の押し%・差、そして押すハンド集合の食い違い（欠落/余剰）を表示。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { BoardState, Position } from '@oshihiki/core';
import { positionsForPlayersLeft, normalizeKey, parseRangeToSet } from '@oshihiki/core';
import type { ActionChar } from '@oshihiki/core';
import { solveMultiway, maxWorkerCap, type MultiwayNSolveOptions } from '../src/nwaySolver.js';

const log = (s: string): void => void process.stderr.write(s + '\n');
const HERE = dirname(fileURLToPath(import.meta.url));
const REF = join(HERE, '..', '..', 'harness', 'cases', '_reference-hrc-5way-blinds05-1-025.json');

interface RefStrategy { actor: Position; vs?: string; type: 'PU' | 'CA' | 'OC'; freqPct: number; range: string; }
interface RefPlayer { pos: Position; stack: number; eqPrePct: number; eqPostPct: number; }
interface RefFile {
  setup: { blinds: { sb: number; bb: number }; ante: { scheme: string; amount: number }; poolPt: number };
  players: RefPlayer[]; strategies: RefStrategy[];
}

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
function buildState(ref: RefFile): BoardState {
  const { sb, bb } = ref.setup.blinds; const ante = ref.setup.ante.amount;
  const seats = ref.players.map((p) => {
    const bet = p.pos === 'SB' ? sb : p.pos === 'BB' ? bb : 0;
    return { pos: p.pos, stack: p.stack - bet - ante, state: 'live' as const, bet };
  });
  const potBets = seats.reduce((a, s) => a + s.bet, 0);
  return { street: 'preflop', blinds: { sb, bb }, ante: { scheme: 'all', amount: ante },
    heroHand: 'KQo', playersLeft: 5, seats, heroPos: 'UTG', pot: potBets + ante * seats.length } as BoardState;
}

async function detail(state: BoardState, ref: RefFile, order: Position[], name: string, opts: MultiwayNSolveOptions) {
  const t0 = Number(process.hrtime.bigint() / 1000000n);
  const res = await solveMultiway(state, opts);
  const ms = Number(process.hrtime.bigint() / 1000000n) - t0;
  const byKey = Object.fromEntries(res.nodes.map((n) => [n.key, n]));
  log(`\n════════ ${name}  (${(ms / 1000).toFixed(1)}s, iters=${res.iterations}) ════════`);
  log(`  行動者  状況        HRC押%  自作押%   差    ハンドの食い違い（-=HRCのみ押す / +=自作だけ押す）`);
  let sum = 0, cnt = 0;
  for (const s of ref.strategies) {
    const node = byKey[keyOf(order, s)];
    if (!node) continue;
    const d = node.pct - s.freqPct; sum += Math.abs(d); cnt++;
    const hrcSet = parseRangeToSet(s.range);
    const mySet = new Set(node.hands);
    const missing = [...hrcSet].filter((h) => !mySet.has(h));
    const extra = [...mySet].filter((h) => !hrcSet.has(h));
    const diffStr = [...missing.map((h) => '-' + h), ...extra.map((h) => '+' + h)].join(' ');
    const vs = (s.vs ?? '最初').padEnd(10);
    log(
      `  ${s.actor.padEnd(4)} ${vs} ${s.freqPct.toFixed(1).padStart(6)} ${node.pct.toFixed(1).padStart(7)} ` +
        `${(d >= 0 ? '+' : '') + d.toFixed(1)}`.padStart(7) + `   ${diffStr || '（一致）'}`,
    );
  }
  log(`  → 平均 |押%差| = ${(sum / cnt).toFixed(2)}pt`);
}

async function main(): Promise<void> {
  const ref = JSON.parse(readFileSync(REF, 'utf8')) as RefFile;
  const order = positionsForPlayersLeft(5);
  const state = buildState(ref);
  const workers = maxWorkerCap();
  log(`# 「速い設定」× 実 HRC 5-way 1手ずつ照合  workers=${workers}`);
  log(`局面: UTG/CO/BU/SB/BB = 10/20/30/23/12bb, blinds 0.5/1, ante all 0.25`);

  await detail(state, ref, order, '基準（最重・最も正確） 80k/800', { samples: 80_000, maxIters: 800, refreshEvery: 100, workers });
  await detail(state, ref, order, '一番速い設定 4k/200', { samples: 4_000, maxIters: 200, refreshEvery: 100, workers });
}
void main();
