import { describe, expect, it } from 'vitest';

import type { HuHandRecord } from './history';
import { cumulativeSeries, filterByPeriod, kLabel, pctLabel, summarize } from './stats';

function rec(over: Partial<HuHandRecord>): HuHandRecord {
  return {
    id: 'sb_abc123',
    playedAt: 0,
    heroSeat: 1,
    action: 'b200f',
    heroCards: ['As', 'Kd'],
    botCards: null,
    board: [],
    winnings: 100,
    showdown: false,
    evWinnings: 100,
    synced: true,
    ...over,
  };
}

describe('cumulativeSeries', () => {
  it('実収支 / EV / SD / NSD を累積する', () => {
    const s = cumulativeSeries([
      rec({ winnings: 100, evWinnings: 100, showdown: false }),
      rec({ winnings: -20000, evWinnings: 5000, showdown: true, action: 'b20000c', botCards: ['Qh', 'Qc'] }),
      rec({ winnings: 300, evWinnings: null, showdown: false }),
    ]);
    expect(s.net).toEqual([100, -19900, -19600]);
    expect(s.ev).toEqual([100, 5100, 5400]);
    expect(s.sd).toEqual([0, -20000, -20000]);
    expect(s.nsd).toEqual([100, 100, 400]);
  });
});

describe('summarize', () => {
  it('Win Rate は bb/100・VPIP/PFR/3Bet は機会で割る', () => {
    const s = summarize([
      rec({ heroSeat: 1, action: 'b200f', winnings: 100 }), // SB オープンで相手降り
      rec({ heroSeat: 0, action: 'f', winnings: 50 }), // walk（機会なし）
      rec({ heroSeat: 0, action: 'b200b600f', winnings: 200 }), // BB 3Bet
      rec({ heroSeat: 0, action: 'b200c/kk/kk/kk', winnings: -150, showdown: true, botCards: ['Qh', 'Qc'], evWinnings: -150 }),
    ]);
    expect(s.hands).toBe(4);
    expect(s.net).toBe(200);
    expect(s.winRate).toBeCloseTo((2 / 4) * 100, 6);
    expect(s.vpip).toEqual({ n: 3, d: 3 });
    expect(s.pfr).toEqual({ n: 2, d: 3 });
    expect(s.threeBet).toEqual({ n: 1, d: 2 });
    expect(s.sd).toBe(-150);
    expect(s.nsd).toBe(350);
  });

  it('空なら 0', () => {
    const s = summarize([]);
    expect(s.hands).toBe(0);
    expect(s.winRate).toBe(0);
    expect(s.firstPlayedAt).toBeNull();
  });
});

describe('filterByPeriod', () => {
  // 2026-09-15 (火) 15:20 ローカル
  const now = new Date(2026, 8, 15, 15, 20).getTime();

  it('直近 N は末尾から', () => {
    const many = Array.from({ length: 1200 }, (_, i) => rec({ playedAt: i }));
    expect(filterByPeriod(many, 'last100', now)).toHaveLength(100);
    expect(filterByPeriod(many, 'last500', now)).toHaveLength(500);
    expect(filterByPeriod(many, 'last1k', now)).toHaveLength(1000);
    expect(filterByPeriod(many, 'all', now)).toHaveLength(1200);
    expect(filterByPeriod(many, 'last100', now)[0]!.playedAt).toBe(1100);
  });
});

describe('labels', () => {
  it('pctLabel / kLabel', () => {
    expect(pctLabel({ n: 1, d: 4 })).toBe('25');
    expect(pctLabel({ n: 0, d: 0 })).toBe('–');
    expect(kLabel(42)).toBe('42');
    expect(kLabel(1300)).toBe('1.3k');
    expect(kLabel(17400)).toBe('17k');
    expect(kLabel(9000)).toBe('9k');
  });
});
