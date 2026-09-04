/**
 * ホームのサンプル投稿の「計算結果」を事前計算して JSON に書き出す（dev ツール）。
 * worker（solver.worker.ts）と同じ 3人パス（pf3way テーブル補間）＋同じ toDto で
 * SolveResultDto を作り、`src/data/sampleResults.json` に埋め込む。
 * これにより、ホームのカードのタップは求解せず即座に結果を表示できる（＝公開済みデータ）。
 *
 * 実行: npx tsx packages/app/scripts/genSampleResults.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildPf3wayTable, pf3wayInRange, lookupPf3way } from '@oshihiki/solver';
import { buildBoardState } from '../src/formModel';
import { SAMPLE_POSTS } from '../src/data/sampleFeed';

const ROOT = resolve(import.meta.dirname, '../../..');
const META = resolve(ROOT, 'packages/solver/artifacts/pf3way.meta.json');
const BIN = resolve(ROOT, 'packages/solver/artifacts/pf3way.f32.bin');

const meta = JSON.parse(readFileSync(META, 'utf8'));
const binBuf = readFileSync(BIN);
const ab = binBuf.buffer.slice(binBuf.byteOffset, binBuf.byteOffset + binBuf.byteLength);
const table = buildPf3wayTable(meta, new Float32Array(ab));

// worker の toDto と同一（SolveResultDto へ整形）。
function toDto(r: any, playersLeft: number, heroPos: string, heroHand: string) {
  const equity = r.nodes.length > 0 ? r.nodes[0].equity : {};
  return {
    playersLeft,
    heroPos,
    heroHand,
    iterations: r.iterations,
    exploitabilityPt: r.exploitabilityPt,
    converged: r.converged,
    equity,
    nodes: r.nodes.map((n: any) => ({
      key: n.key,
      actor: n.actor,
      actionType: n.actionType,
      pct: n.pct,
      range: n.range,
      hands: n.hands,
      heroFreq: n.freq[heroHand] ?? 0,
      heroEv: n.ev[heroHand] ?? 0,
    })),
  };
}

const out: Record<string, unknown> = {};
for (const post of SAMPLE_POSTS) {
  const built = buildBoardState(post.form);
  if (!built.ok || !built.state) {
    throw new Error(`sample ${post.id}: buildBoardState failed: ${built.issues.join(', ')}`);
  }
  const state = built.state;
  if (state.playersLeft !== 3 || !pf3wayInRange(table, state)) {
    throw new Error(`sample ${post.id}: 3人テーブル範囲外（サンプルは3人・表内スタックに限定）`);
  }
  const r = lookupPf3way(table, state);
  const dto = toDto(r, 3, state.heroPos, state.heroHand);
  out[post.id] = { state, result: dto, ms: 0 };
  const head = dto.nodes.find((n: any) => n.actor === state.heroPos);
  console.log(`${post.id}: ${state.heroHand} ${state.heroPos} ${state.playersLeft}way -> PU ${head?.pct?.toFixed(1)}% heroEv ${head?.heroEv?.toFixed(3)}`);
}

const OUT = resolve(ROOT, 'packages/app/src/data/sampleResults.json');
writeFileSync(OUT, JSON.stringify(out, null, 0) + '\n', 'utf8');
console.log(`wrote ${OUT} (${Object.keys(out).length} spots)`);
