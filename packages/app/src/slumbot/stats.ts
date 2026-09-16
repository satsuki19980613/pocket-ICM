/**
 * Slumbot HU の成績集計（SPEC §7.4.6 Stats 画面）。
 * 入力は playedAt 昇順の記録。すべて純関数。単位はチップ（BB=100）。
 */

import { preflopFacts, walkActions, type HuHandRecord } from './history';

export type Period = 'last100' | 'last500' | 'last1k' | 'all';

export const PERIODS: readonly { key: Period; label: string }[] = [
  { key: 'last100', label: '100' },
  { key: 'last500', label: '500' },
  { key: 'last1k', label: '1k' },
  { key: 'all', label: 'All' },
];

/** 期間で絞る（入力は昇順・出力も昇順）。 */
export function filterByPeriod(
  recs: readonly HuHandRecord[],
  period: Period,
  now: number = Date.now(),
): HuHandRecord[] {
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

export interface Series {
  /** 実収支の累積。index i は i+1 ハンド目まで。 */
  readonly net: readonly number[];
  readonly ev: readonly number[];
  /** ショーダウンで決まったハンドの累積収支。 */
  readonly sd: readonly number[];
  /** 相手か自分が降りて決まったハンドの累積収支。 */
  readonly nsd: readonly number[];
}

/** 未計算の EV は実収支で代用する（グラフが欠けないように）。 */
export function evOf(r: HuHandRecord): number {
  return r.evWinnings ?? r.winnings;
}

export function cumulativeSeries(recs: readonly HuHandRecord[]): Series {
  const net: number[] = [];
  const ev: number[] = [];
  const sd: number[] = [];
  const nsd: number[] = [];
  let a = 0;
  let b = 0;
  let c = 0;
  let d = 0;
  for (const r of recs) {
    a += r.winnings;
    b += evOf(r);
    if (r.showdown) c += r.winnings;
    else d += r.winnings;
    net.push(a);
    ev.push(b);
    sd.push(c);
    nsd.push(d);
  }
  return { net, ev, sd, nsd };
}

export interface Ratio {
  readonly n: number;
  readonly d: number;
}

export interface Summary {
  readonly hands: number;
  readonly net: number;
  readonly ev: number;
  /** bb/100 */
  readonly winRate: number;
  readonly evWinRate: number;
  readonly sd: number;
  readonly nsd: number;
  readonly vpip: Ratio;
  readonly pfr: Ratio;
  readonly threeBet: Ratio;
  readonly firstPlayedAt: number | null;
  readonly lastPlayedAt: number | null;
}

export function summarize(recs: readonly HuHandRecord[]): Summary {
  let net = 0;
  let ev = 0;
  let sd = 0;
  let nsd = 0;
  let vpipN = 0;
  let vpipD = 0;
  let pfrN = 0;
  let tbN = 0;
  let tbD = 0;
  for (const r of recs) {
    net += r.winnings;
    ev += evOf(r);
    if (r.showdown) sd += r.winnings;
    else nsd += r.winnings;
    const w = walkActions(r.action);
    if (w) {
      const f = preflopFacts(w.steps, r.heroSeat);
      if (f.vpipOpp) vpipD += 1;
      if (f.vpip) vpipN += 1;
      if (f.pfr) pfrN += 1;
      if (f.threeBetOpp) tbD += 1;
      if (f.threeBet) tbN += 1;
    }
  }
  const n = recs.length;
  const rate = (chips: number): number => (n > 0 ? (chips / 100 / n) * 100 : 0);
  return {
    hands: n,
    net,
    ev,
    winRate: rate(net),
    evWinRate: rate(ev),
    sd,
    nsd,
    vpip: { n: vpipN, d: vpipD },
    pfr: { n: pfrN, d: vpipD },
    threeBet: { n: tbN, d: tbD },
    firstPlayedAt: n > 0 ? recs[0]!.playedAt : null,
    lastPlayedAt: n > 0 ? recs[n - 1]!.playedAt : null,
  };
}

/** 比率の % 表示（分母 0 は "–"）。 */
export function pctLabel(r: Ratio): string {
  return r.d > 0 ? String(Math.round((r.n / r.d) * 100)) : '–';
}

/** 1.3k / 17.4k のような短い件数表示。 */
export function kLabel(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k < 10 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)}k`;
}
