import { describe, it, expect } from 'vitest';
import {
  ALL_CLUB_MATCH_LEVELS,
  CLUB_MATCH_LEVELS,
  CLUB_MATCH_LEVELS_SLOW,
  CLUB_MATCH_LEVELS_VERY_SLOW,
  CLUB_MATCH_TOTAL_CHIPS,
  snapByBb,
  resolveBlindChips,
  anteBbOf,
  totalBbFromBbChips,
} from './blindLevels.js';

describe('blindLevels', () => {
  it('公式「通常」表は 16 レベル・SB=BB/2・単調増加', () => {
    expect(CLUB_MATCH_LEVELS).toHaveLength(16);
    for (const lv of CLUB_MATCH_LEVELS) expect(lv.sb).toBe(lv.bb / 2);
    for (let i = 1; i < CLUB_MATCH_LEVELS.length; i++) {
      expect(CLUB_MATCH_LEVELS[i]!.bb).toBeGreaterThan(CLUB_MATCH_LEVELS[i - 1]!.bb);
    }
  });

  it('公式表レベル1（100/200/50）が存在', () => {
    const lv = CLUB_MATCH_LEVELS.find((l) => l.bb === 200);
    expect(lv).toBeDefined();
    expect(lv!.sb).toBe(100);
    expect(lv!.ante).toBe(50);
    expect(lv!.level).toBe(1);
  });

  it('snapByBb: タイト（2%）一致で公式レベルへ・小誤読を補正', () => {
    expect(snapByBb(200)!.level).toBe(1);
    expect(snapByBb(203)!.level).toBe(1); // 1.5% 内
    expect(snapByBb(3800)!.level).toBe(9);
  });

  it('snapByBb: どの公式表にも無い BB はスナップしない', () => {
    // 700 は 660(ゆっくり7)/740(もっとゆっくり14) から 5〜6% 離れる → null（誤スナップしない）。
    expect(snapByBb(700)).toBeNull();
    expect(snapByBb(NaN)).toBeNull();
    expect(snapByBb(0)).toBeNull();
    expect(snapByBb(123456789)).toBeNull();
  });

  it('snapByBb: 「ゆっくり」の 800/960 は表に載ったので正しく一致する', () => {
    // 以前は表が「通常」だけだったため 800 は 780 へ誤スナップ（→ gate 2% で回避）、
    // 960 は「表に無い別スピード」として読み値採用だった。構造表の登録でどちらも厳密一致する。
    const s800 = snapByBb(800)!;
    expect(s800.speed).toBe('slow');
    expect(s800.level).toBe(8);
    expect(s800.ante).toBe(200);
    const s960 = snapByBb(960)!;
    expect(s960.speed).toBe('slow');
    expect(s960.level).toBe(9);
    expect(s960.ante).toBe(240);
  });

  it('snapByBb: BB が同じで ante だけ違う組は読み取った ante で decide する', () => {
    // BB=300 は「ゆっくり」lv3(ante 75) と「もっとゆっくり」lv5(ante 70) の両方にある。
    expect(snapByBb(300, 0.02, 75)!.speed).toBe('slow');
    expect(snapByBb(300, 0.02, 70)!.speed).toBe('veryslow');
    // BB=13000 は「通常」lv12(ante 3200) と「もっとゆっくり」lv43(ante 3300)。
    expect(snapByBb(13000, 0.02, 3200)!.speed).toBe('normal');
    expect(snapByBb(13000, 0.02, 3300)!.speed).toBe('veryslow');
  });

  it('公式表3種は SB=BB/2・単調増加・ante は 0.2〜0.3×BB', () => {
    expect(CLUB_MATCH_LEVELS_SLOW).toHaveLength(32);
    expect(CLUB_MATCH_LEVELS_VERY_SLOW).toHaveLength(59);
    for (const t of [CLUB_MATCH_LEVELS, CLUB_MATCH_LEVELS_SLOW, CLUB_MATCH_LEVELS_VERY_SLOW]) {
      let prev = 0;
      for (const lv of t) {
        expect(lv.sb).toBe(lv.bb / 2);
        expect(lv.bb).toBeGreaterThan(prev);
        expect(lv.ante / lv.bb).toBeGreaterThanOrEqual(0.2);
        expect(lv.ante / lv.bb).toBeLessThanOrEqual(0.3);
        prev = lv.bb;
      }
    }
    // 3 表とも最終レベルは 60000/30000/15000（構造表の実測）。
    for (const t of [CLUB_MATCH_LEVELS, CLUB_MATCH_LEVELS_SLOW, CLUB_MATCH_LEVELS_VERY_SLOW]) {
      const last = t[t.length - 1]!;
      expect([last.bb, last.sb, last.ante]).toEqual([60000, 30000, 15000]);
    }
    expect(ALL_CLUB_MATCH_LEVELS).toHaveLength(16 + 32 + 59);
  });

  it('resolveBlindChips: 公式「通常」はタイト一致で厳密値（142308＝レベル1）', () => {
    const r = resolveBlindChips(100, 200, 50)!;
    expect(r.level).toBe(1);
    expect(r.bb).toBe(200);
    expect(r.sb).toBe(100);
    expect(r.ante).toBe(50);
  });

  it('resolveBlindChips: 480/960/240 は「ゆっくり」lv9 として厳密一致する', () => {
    const r = resolveBlindChips(480, 960, 240)!;
    expect(r.speed).toBe('slow');
    expect(r.level).toBe(9);
    expect(r.bb).toBe(960);
    expect(r.sb).toBe(480);
    expect(r.ante).toBe(240);
    // 保存則: 総 BB = 90000/960 = 93.75。
    expect(totalBbFromBbChips(r.bb)).toBeCloseTo(93.75, 6);
  });

  it('resolveBlindChips: どの表にも無い構造は読み値採用・level=0・SB=BB/2', () => {
    const r = resolveBlindChips(350, 700, 175)!;
    expect(r.level).toBe(0);
    expect(r.speed).toBeUndefined();
    expect(r.bb).toBe(700);
    expect(r.sb).toBe(350);
    expect(r.ante).toBe(175);
  });

  it('resolveBlindChips: BB 誤読は SB×2 で救済／アンティ外れは 0.25×BB 近似', () => {
    // BB 欠測 → SB 480×2=960（別スピード扱い）。
    const r1 = resolveBlindChips(480, NaN, 240)!;
    expect(r1.bb).toBe(960);
    expect(r1.sb).toBe(480);
    // アンティが妥当域外（大きすぎ）→ 0.25×BB 近似。
    const r2 = resolveBlindChips(480, 960, 900)!;
    expect(r2.ante).toBe(240);
  });

  it('resolveBlindChips: BB も SB も読めなければ null（チェック無効）', () => {
    expect(resolveBlindChips(NaN, NaN, NaN)).toBeNull();
    expect(resolveBlindChips(0, 0, 0)).toBeNull();
  });

  it('anteBbOf: 各レベルのアンティは概ね 0.25×BB', () => {
    for (const lv of CLUB_MATCH_LEVELS) {
      expect(anteBbOf(lv)).toBeGreaterThan(0.24);
      expect(anteBbOf(lv)).toBeLessThan(0.27);
    }
  });

  it('totalBbFromBbChips: 90000/200 = 450・90000/960 = 93.75', () => {
    expect(CLUB_MATCH_TOTAL_CHIPS).toBe(90000);
    expect(totalBbFromBbChips(200)).toBeCloseTo(450, 6);
    expect(totalBbFromBbChips(960)).toBeCloseTo(93.75, 6);
  });
});
