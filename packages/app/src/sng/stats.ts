/**
 * SIT & GO の成績集計（docs/SNG_DESIGN.md §5 STATS 画面）。
 * 入力は `endedAt` 昇順の試合結果（`historyStore.ts` の `SngResultLocal`）。すべて純関数。
 *
 * 期間の考え方（直近N）は Slumbot HU（`slumbot/stats.ts`）と同じにする。`Period` は
 * ハンド固有の型に依存しない純粋な型なのでそのまま流用し、フィルタ本体だけ
 * SIT & GO の結果（1 件＝1 試合）向けに書く。
 */

import type { Period, Ratio } from '../slumbot/stats';
import type { SngResultLocal } from './historyStore';

export { PERIODS, type Period, type Ratio } from '../slumbot/stats';

/** 期間で絞る（入力は endedAt 昇順・出力も昇順）。 */
export function filterByPeriod(
  recs: readonly SngResultLocal[],
  period: Period,
  now: number = Date.now(),
): SngResultLocal[] {
  switch (period) {
    case 'last100':
      return recs.slice(-100);
    case 'last500':
      return recs.slice(-500);
    case 'last1k':
      return recs.slice(-1000);
    case 'all':
      return [...recs];
  }
}

export interface PtPoint {
  /** 1 始まりの試合数。 */
  readonly x: number;
  /** その試合まで打ち終えた時点の累計 pt。 */
  readonly y: number;
}

/** 累計 pt の時系列（入力は endedAt 昇順）。 */
export function cumulativePt(results: readonly SngResultLocal[]): PtPoint[] {
  let sum = 0;
  return results.map((r, i) => {
    sum += r.pt;
    return { x: i + 1, y: sum };
  });
}

/** 直近 n 試合の順位（古い→新しいの順。`SngStatsView` の「直近の成績」に使う）。 */
export function recentPlaces(results: readonly SngResultLocal[], n = 10): number[] {
  return results.slice(-n).map((r) => r.place);
}

export interface SngSummary {
  readonly games: number;
  readonly avgPlace: number;
  /** 1 位の回数 / 試合数。 */
  readonly firstRate: Ratio;
  /** pt > 0 の回数 / 試合数。 */
  readonly cashRate: Ratio;
  readonly totalPt: number;
  /** index 0 = 1 位の件数 … index 5 = 6 位の件数。 */
  readonly placeDist: readonly number[];
  /** 集計対象の中でいちばん人数が多かった試合の人数（順位分布を何位まで見せるかの目安）。 */
  readonly maxPlayers: number;
  readonly firstPlayedAt: number | null;
  readonly lastPlayedAt: number | null;
}

/** 成績の集計（入力は endedAt 昇順）。 */
export function summarizeSng(results: readonly SngResultLocal[]): SngSummary {
  const n = results.length;
  let placeSum = 0;
  let firstN = 0;
  let cashN = 0;
  let totalPt = 0;
  let maxPlayers = 0;
  const placeDist = [0, 0, 0, 0, 0, 0];
  for (const r of results) {
    placeSum += r.place;
    if (r.place === 1) firstN += 1;
    if (r.pt > 0) cashN += 1;
    totalPt += r.pt;
    if (r.place >= 1 && r.place <= placeDist.length) placeDist[r.place - 1] = (placeDist[r.place - 1] ?? 0) + 1;
    if (r.players > maxPlayers) maxPlayers = r.players;
  }
  return {
    games: n,
    avgPlace: n > 0 ? placeSum / n : 0,
    firstRate: { n: firstN, d: n },
    cashRate: { n: cashN, d: n },
    totalPt,
    placeDist,
    maxPlayers,
    firstPlayedAt: n > 0 ? results[0]!.endedAt : null,
    lastPlayedAt: n > 0 ? results[n - 1]!.endedAt : null,
  };
}
