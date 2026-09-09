import { describe, it, expect } from 'vitest';
import { RANKS, handLabel } from '../handGrid';
import type { SolveNodeDto, SolveResultDto } from '../solverProtocol';
import { decodeSolution, encodeSolution } from './solutionCodec';

/**
 * 169 ハンドクラスの正準順（handGrid.ts の行×列走査＝アプリ全体の単一の真実）。
 * ここではダミーデータのハンド表記を実物と同じ語彙で埋めるためだけに使う
 * （solutionCodec.ts 自体は圧縮を実装しないため、この並びに依存しない）。
 */
const HAND_CLASSES_169: string[] = (() => {
  const order: string[] = [];
  for (let r = 0; r < RANKS.length; r++) {
    for (let c = 0; c < RANKS.length; c++) order.push(handLabel(r, c));
  }
  return order;
})();

/**
 * 実測: `packages/solver` の `solveMultiway` を 6人・等スタック15bb（アンティ無し,
 * maxIters:200/samples:16000, packages/solver/test/nwaySolver.test.ts の CFG と同一）で
 * 実行し、62 決定ノード（`2^6-2`、同テストで固定済みのノード数）それぞれの
 * `hands.length`（純化後にプッシュ/コール/オーバーコール側に入ったハンドクラス数）を
 * 記録したもの。ノード順は `packages/solver/src/nwaySolver.ts` の列挙順。
 */
const OBSERVED_HANDS_LENGTHS_15BB = [
  6, 9, 1, 8, 4, 3, 3, 23, 3, 3, 1, 4, 2, 1, 1, 148, 3, 3, 2, 5, 1, 1, 0, 9, 2, 2, 3, 2, 2, 0, 2, 5, 5, 3, 4, 3, 1, 2,
  9, 2, 3, 0, 1, 5, 2, 2, 14, 3, 1, 1, 3, 0, 1, 0, 5, 0, 2, 0, 2, 0, 0, 0,
];

/** 同条件・短スタック8bb（レンジが広がる悪化方向）での実測。169=全ハンドが入るノードも実在する。 */
const OBSERVED_HANDS_LENGTHS_8BB = [
  10, 15, 4, 23, 3, 2, 3, 36, 3, 4, 0, 4, 4, 1, 0, 169, 3, 6, 4, 7, 1, 2, 2, 9, 1, 1, 0, 3, 0, 7, 0, 9, 11, 1, 7, 1, 3,
  0, 20, 1, 2, 3, 5, 0, 2, 1, 27, 3, 2, 0, 1, 3, 0, 2, 5, 6, 1, 0, 2, 1, 1, 0,
];

/**
 * ダミーの range 表記（実際の `formatRange` はもっと圧縮した記法だが、ここでは
 * カンマ区切りの生列挙にして**サイズを悪化方向に見積もる**＝安全側の実測にする）。
 */
function dummyRange(n: number): string {
  return HAND_CLASSES_169.slice(0, n).join(',');
}

/** 実測の hands.length 分布から、代表的な6人局面の SolveResultDto を組み立てる（純データ）。 */
function buildRepresentativeDto(handsLengths: readonly number[]): SolveResultDto {
  const positions = ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'];
  const nodes: SolveNodeDto[] = handsLengths.map((len, i) => ({
    // 実キーは「行動順を actor と F/P/C で埋めた6桁」相当の長さ感。
    key: `k${String(i).padStart(2, '0')}-------`,
    actor: positions[i % positions.length]!,
    actionType: i % 3 === 0 ? 'PU' : i % 3 === 1 ? 'CA' : 'OC',
    pct: Math.round((len / 169) * 10000) / 100,
    range: dummyRange(len),
    hands: HAND_CLASSES_169.slice(0, len),
    heroFreq: len > 0 ? 1 : 0,
    heroEv: len > 0 ? 0.42 : -0.1,
  }));
  const equity: SolveResultDto['equity'] = {};
  for (const pos of positions) equity[pos] = { pre: 0.166, post: 0.2 };
  return {
    playersLeft: 6,
    heroPos: 'BTN',
    heroHand: 'AKs',
    iterations: 200,
    exploitabilityPt: 0.004,
    converged: true,
    equity,
    nodes,
  };
}

describe('solution JSON size（SPEC §7.2 の圧縮閾値=60KB）', () => {
  it('62 決定ノード（6人局面の action tree サイズ）で組み立てられる', () => {
    expect(buildRepresentativeDto(OBSERVED_HANDS_LENGTHS_15BB).nodes).toHaveLength(62);
  });

  it('15bb 実測ベースの代表局面は 60KB を大きく下回る', () => {
    const dto = buildRepresentativeDto(OBSERVED_HANDS_LENGTHS_15BB);
    const bytes = JSON.stringify(dto).length;
    expect(bytes).toBeLessThan(60 * 1024);
    // ダミーの range 表記は実物より長くなる方向（安全側）だが、それでも閾値の半分未満。
    expect(bytes).toBeLessThan(30 * 1024);
  });

  it('短スタック8bb実測ベース（最も広いレンジ＝悪化方向）でも 60KB を下回る', () => {
    const dto = buildRepresentativeDto(OBSERVED_HANDS_LENGTHS_8BB);
    const bytes = JSON.stringify(dto).length;
    expect(bytes).toBeLessThan(60 * 1024);
  });
});

describe('encodeSolution / decodeSolution', () => {
  it('実測が60KB未満のため圧縮しない＝恒等写像（encode→decode で完全一致）', () => {
    const dto = buildRepresentativeDto(OBSERVED_HANDS_LENGTHS_15BB);
    const encoded = encodeSolution(dto);
    expect(encoded).toBe(dto);
    const decoded = decodeSolution(encoded);
    expect(decoded).toEqual(dto);
  });
});
