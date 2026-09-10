import { describe, it, expect } from 'vitest';
import {
  CLUB_MATCH_LEVELS,
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

  it('snapByBb: 別スピードの BB（表に無い）はスナップしない', () => {
    // 960 は 780(lv5)/1100(lv6) から 12〜19% 離れる → null（誤スナップしない）。
    expect(snapByBb(960)).toBeNull();
    // 回帰: 別スピード 400/800 は表の 780 から 2.6% しか離れておらず、旧 gate(6%) では
    // 780 へ誤スナップしていた。総チップ保存の理論値が 112.5→115.4 とずれ、スタックを
    // 2.9bb も書き換えかねなかった（GT: Screenshot_20260901-142955 / -143002）。
    expect(snapByBb(800)).toBeNull();
    expect(snapByBb(NaN)).toBeNull();
    expect(snapByBb(0)).toBeNull();
    expect(snapByBb(123456789)).toBeNull();
  });

  it('resolveBlindChips: 公式「通常」はタイト一致で厳密値（142308＝レベル1）', () => {
    const r = resolveBlindChips(100, 200, 50)!;
    expect(r.level).toBe(1);
    expect(r.bb).toBe(200);
    expect(r.sb).toBe(100);
    expect(r.ante).toBe(50);
  });

  it('resolveBlindChips: 別スピード（480/960/240）は読み値採用・level=0・SB=BB/2', () => {
    const r = resolveBlindChips(480, 960, 240)!;
    expect(r.level).toBe(0);
    expect(r.bb).toBe(960);
    expect(r.sb).toBe(480); // BB/2 を強制
    expect(r.ante).toBe(240); // 妥当域（0.25×960）なので読み値
    // 保存則: 総 BB = 90000/960 = 93.75。
    expect(totalBbFromBbChips(r.bb)).toBeCloseTo(93.75, 6);
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
