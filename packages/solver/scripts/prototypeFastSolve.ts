/**
 * プロトタイプ（妥当性検証・dev専用）: 「速いモンテカルロ」案（案Step1）の検証。
 *
 * 目的: サンプル数と反復回数を落として（＋既存の exploitability 早期停止を活かして）
 * どれだけ速くなるか、そのとき精度（実 HRC 5-way 参照との一致）がどれだけ崩れるかを
 * 同一マシンで横並び計測する。案が妥当なら「大幅に速い設定でも HRC 一致 ±0.5pt を保つ」
 * はず。崩れるなら分散低減など次策が要る、という判断材料。
 *
 * 参照: packages/harness/cases/_reference-hrc-5way-blinds05-1-025.json（さつき収集の実 HRC 値）
 *
 * 実行:
 *   node --import tsx packages/solver/scripts/prototypeFastSolve.ts
 *   （worker はマシンの 60% コアを自動使用。単一スレッド比較は OSHIHIKI_WORKERS=1）
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
  players: RefPlayer[];
  strategies: RefStrategy[];
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
  const { sb, bb } = ref.setup.blinds;
  const ante = ref.setup.ante.amount;
  const seats = ref.players.map((p) => {
    const bet = p.pos === 'SB' ? sb : p.pos === 'BB' ? bb : 0;
    return { pos: p.pos, stack: p.stack - bet - ante, state: 'live' as const, bet };
  });
  const potBets = seats.reduce((a, s) => a + s.bet, 0);
  return {
    street: 'preflop', blinds: { sb, bb }, ante: { scheme: 'all', amount: ante },
    heroHand: 'KQo', playersLeft: 5, seats, heroPos: 'UTG', pot: potBets + ante * seats.length,
  } as BoardState;
}

interface Config { name: string; opts: MultiwayNSolveOptions; }

/** 1 設定を解いて、HRC 参照との精度と時間を測る。 */
async function runOne(state: BoardState, ref: RefFile, order: Position[], cfg: Config) {
  const t0 = Number(process.hrtime.bigint() / 1000000n);
  const res = await solveMultiway(state, cfg.opts);
  const ms = Number(process.hrtime.bigint() / 1000000n) - t0;

  // EQPost 最大差（シフト形 pct）
  const toShiftedPct = (realPt: number): number => ((realPt + 1) / ref.setup.poolPt) * 100;
  let maxEqPost = 0;
  for (const p of ref.players) {
    const post = toShiftedPct(res.equity[p.pos]!.post);
    maxEqPost = Math.max(maxEqPost, Math.abs(post - p.eqPostPct));
  }

  // 戦略: 平均 |freq% 差| と 最大 |freq% 差|
  const byKey = Object.fromEntries(res.nodes.map((n) => [n.key, n]));
  let freqAbsSum = 0, freqAbsMax = 0, cnt = 0, handDiff = 0;
  for (const s of ref.strategies) {
    const node = byKey[keyOf(order, s)];
    if (!node) continue;
    const d = Math.abs(node.pct - s.freqPct);
    freqAbsSum += d; freqAbsMax = Math.max(freqAbsMax, d); cnt++;
    const hrcSet = parseRangeToSet(s.range);
    const mySet = new Set(node.hands);
    handDiff += [...hrcSet].filter((h) => !mySet.has(h)).length + [...mySet].filter((h) => !hrcSet.has(h)).length;
  }
  return {
    name: cfg.name, ms, iters: res.iterations, converged: res.converged,
    expl: res.exploitabilityPt, maxEqPost, avgFreq: freqAbsSum / cnt, maxFreq: freqAbsMax, handDiff,
  };
}

async function main(): Promise<void> {
  const ref = JSON.parse(readFileSync(REF, 'utf8')) as RefFile;
  const order = positionsForPlayersLeft(5);
  const state = buildState(ref);
  const workers = maxWorkerCap();

  log(`# 「速いMC」案 プロトタイプ検証 — 実 HRC 5-way 照合`);
  log(`node ${process.version}  workers=${workers}  (このマシンのコア数依存: 絶対秒より速度比を見る)\n`);

  // GOLD（現状の検証設定）→ current App(5-way) → 段階的に軽く。
  const configs: Config[] = [
    { name: 'GOLD  80k/800 ', opts: { samples: 80_000, maxIters: 800, refreshEvery: 100, workers } },
    { name: 'App   32k/600 ', opts: { samples: 32_000, maxIters: 600, refreshEvery: 100, workers } },
    { name: 'fast1 16k/400 ', opts: { samples: 16_000, maxIters: 400, refreshEvery: 100, workers } },
    { name: 'fast2 10k/300 ', opts: { samples: 10_000, maxIters: 300, refreshEvery: 100, workers } },
    { name: 'fast3  6k/250 ', opts: { samples: 6_000, maxIters: 250, refreshEvery: 100, workers } },
    { name: 'fast4  4k/200 ', opts: { samples: 4_000, maxIters: 200, refreshEvery: 100, workers } },
  ];

  const rows = [];
  for (const cfg of configs) {
    const r = await runOne(state, ref, order, cfg);
    rows.push(r);
    log(
      `${r.name} | ${(r.ms / 1000).toFixed(1).padStart(6)}s | iters ${String(r.iters).padStart(3)} ` +
        `conv=${r.converged ? 'Y' : 'n'} | expl ${r.expl.toFixed(4)} | ` +
        `EQPost最大差 ${r.maxEqPost.toFixed(2)}pt | 平均|freq%| ${r.avgFreq.toFixed(2)}pt ` +
        `最大 ${r.maxFreq.toFixed(1)}pt | レンジ差 ${r.handDiff}手`,
    );
  }

  const gold = rows[0]!;
  log(`\n## 速度比（GOLD比）と精度サマリ`);
  for (const r of rows) {
    const speedup = gold.ms / r.ms;
    const ok = r.avgFreq <= 0.5 ? 'OK' : r.avgFreq <= 1.0 ? '△' : '×';
    log(`  ${r.name}: ${speedup.toFixed(1)}x  平均|freq%|=${r.avgFreq.toFixed(2)}pt [${ok}]`);
  }
}

void main();
