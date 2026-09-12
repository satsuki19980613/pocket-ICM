import { describe, it, expect } from 'vitest';
import {
  GAME_KINDS,
  GAME_MODES,
  MODES_BY_KIND,
  GAME_MODE_SPECS,
  gameModeLabel,
  gameModeSpec,
  ptDisplayScale,
  totalChipsOf,
  BoardStateSchema,
} from '../src/index.js';

describe('GAME_MODE_SPECS', () => {
  it('クラブマッチは SPEC §2.1 の実払い（公式 season23〜30 で不変を確認）', () => {
    expect(GAME_MODE_SPECS.club.payouts).toEqual([5, 3, 2, 1, 0, -1]);
    expect(totalChipsOf('club')).toBe(90000); // 6 人 × 15,000
  });

  it('レジェンドマッチの2レートは公式告知の値（season1〜5 で不変）', () => {
    expect(GAME_MODE_SPECS['legend-season'].payouts).toEqual([40, 15, 3, 0, -18, -40]);
    expect(GAME_MODE_SPECS['legend-base'].payouts).toEqual([35, 21, 7, -7, -21, -35]);
    expect(totalChipsOf('legend-avg')).toBe(120000); // 6 人 × 20,000
  });

  it('平均は2レートの素点平均', () => {
    expect(GAME_MODE_SPECS['legend-avg'].payouts).toEqual([37.5, 18, 5, -3.5, -19.5, -37.5]);
  });

  it('平均は必ず両レートの中間にある（選択を誤ったときの誤差が半分に収まる根拠）', () => {
    const s = GAME_MODE_SPECS['legend-season'].payouts;
    const b = GAME_MODE_SPECS['legend-base'].payouts;
    const a = GAME_MODE_SPECS['legend-avg'].payouts;
    for (let i = 0; i < 6; i++) {
      expect(a[i]!).toBeGreaterThanOrEqual(Math.min(s[i]!, b[i]!));
      expect(a[i]!).toBeLessThanOrEqual(Math.max(s[i]!, b[i]!));
    }
  });

  it('ベースレートは順位に対して完全な等差＝正規化すると (5,4,3,2,1,0)', () => {
    const p = GAME_MODE_SPECS['legend-base'].payouts;
    const gaps = p.slice(1).map((v, i) => p[i]! - v);
    expect(new Set(gaps).size).toBe(1);
  });

  it('レジェンドはクラブのアフィン変換では**ない**（＝表の流用不可・再生成が要る）', () => {
    const norm = (p: readonly number[]): number[] => {
      const lo = p[p.length - 1]!;
      const hi = p[0]!;
      return p.map((x) => (x - lo) / (hi - lo));
    };
    const club = norm(GAME_MODE_SPECS.club.payouts);
    for (const m of ['legend-avg', 'legend-season', 'legend-base'] as const) {
      expect(norm(GAME_MODE_SPECS[m].payouts)).not.toEqual(club);
    }
  });

  it('ptDisplayScale はクラブ尺度へそろえる（クラブは 1 倍）', () => {
    expect(ptDisplayScale('club')).toBe(1);
    expect(ptDisplayScale('legend-season')).toBeCloseTo(6 / 80, 12);
    // 換算後の振れ幅はどのモードでもクラブと同じ 6 になる。
    for (const m of GAME_MODES) {
      const p = GAME_MODE_SPECS[m].payouts;
      expect((p[0]! - p[5]!) * ptDisplayScale(m)).toBeCloseTo(6, 12);
    }
  });

  it('ランクマッチは STAGE ごとに開始スタックが変わる（総チップの基準が変わる）', () => {
    expect(GAME_MODE_SPECS['rank-3'].startingStack).toBe(10000);
    expect(GAME_MODE_SPECS['rank-4'].startingStack).toBe(15000);
    expect(GAME_MODE_SPECS['rank-5'].startingStack).toBe(20000);
    expect(totalChipsOf('rank-3')).toBe(60000);
    expect(totalChipsOf('rank-4')).toBe(90000);
    expect(totalChipsOf('rank-5')).toBe(120000);
  });

  it('総チップは衝突する＝総チップからモードを自動判定してはいけない', () => {
    // STAGE Ⅳ はクラブと、STAGE Ⅴ はレジェンドと同じ総チップになる。
    expect(totalChipsOf('rank-4')).toBe(totalChipsOf('club'));
    expect(totalChipsOf('rank-5')).toBe(totalChipsOf('legend-avg'));
  });

  it('STAGE Ⅰ・Ⅱ は載せない（順位別ポイントが確定していないため・推測で入れない）', () => {
    expect(GAME_MODES).not.toContain('rank-1');
    expect(GAME_MODES).not.toContain('rank-2');
  });

  it('すべてのモードがどれかの系統から選べる（UI に出ない孤児を作らない）', () => {
    const reachable = GAME_KINDS.flatMap((k) => MODES_BY_KIND[k]);
    expect([...reachable].sort()).toEqual([...GAME_MODES].sort());
  });

  it('ラベルは系統ごとに形が違う', () => {
    expect(gameModeLabel('rank-4')).toBe('ランクマッチ STAGE Ⅳ');
    expect(gameModeLabel('legend-season')).toBe('レジェンドマッチ（シーズン）');
    expect(gameModeLabel('club')).toBe('クラブマッチ');
  });

  it('未指定はクラブ扱い（v3 以前の記録が壊れない）', () => {
    expect(gameModeSpec(undefined).id).toBe('club');
    expect(totalChipsOf(undefined)).toBe(90000);
    expect(gameModeLabel(undefined)).toBe('クラブマッチ');
    expect(gameModeLabel('legend-avg')).toBe('レジェンドマッチ（平均）');
  });
});

describe('BoardState の gameMode', () => {
  const base = {
    street: 'preflop' as const,
    blinds: { sb: 0.5, bb: 1 },
    ante: { scheme: 'all' as const, amount: 0.25 },
    heroHand: 'A5s',
    playersLeft: 2,
    seats: [
      { pos: 'SB' as const, stack: 9.25, state: 'live' as const, bet: 0.5 },
      { pos: 'BB' as const, stack: 8.75, state: 'live' as const, bet: 1 },
    ],
    heroPos: 'SB' as const,
  };

  it('省略できる（既存データとの互換）', () => {
    expect(BoardStateSchema.safeParse(base).success).toBe(true);
  });

  it('既知のモードだけ通る', () => {
    expect(BoardStateSchema.safeParse({ ...base, gameMode: 'legend-avg' }).success).toBe(true);
    expect(BoardStateSchema.safeParse({ ...base, gameMode: 'legend' }).success).toBe(false);
  });
});
