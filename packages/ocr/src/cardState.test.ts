/**
 * カード裏状態（active/folded）の合成テスト（画像非依存）。実画像は dev harness
 * （probeCardState）で 142820/142844 の active/folded 8/8 を確認済み（142844 は実物照合で
 * エージェント誤ラベルを訂正）。ここでは明るい青→active / 暗い青→folded / 紫→非active を固定する。
 */
import { describe, it, expect } from 'vitest';
import type { Rgba } from './color.js';
import type { Rect } from './types.js';
import { blueFractions, isActiveHand, pickHandActiveRule, type BlueFractions } from './cardState.js';

/** 単色で塗った領域。 */
function solid(r: number, g: number, b: number): Rgba {
  const w = 40, h = 40;
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255; }
  return { w, h, data };
}
const full = (b: Rgba): Rect => ({ x: 0, y: 0, w: b.w, h: b.h });

describe('blueFractions', () => {
  it('明るい青は strong も bright も高い', () => {
    const b = solid(60, 90, 200);
    const fr = blueFractions(b, full(b));
    expect(fr.strong).toBeGreaterThan(0.9);
    expect(fr.bright).toBeGreaterThan(0.9);
  });
  it('暗い紺は strong 高・bright 低', () => {
    const b = solid(20, 40, 110);
    const fr = blueFractions(b, full(b));
    expect(fr.strong).toBeGreaterThan(0.9);
    expect(fr.bright).toBe(0);
  });
  it('紫（B≈R）は strong 低', () => {
    const b = solid(100, 45, 130);
    expect(blueFractions(b, full(b)).strong).toBe(0);
  });
});

describe('isActiveHand', () => {
  it('明るい青カード → active', () => {
    const b = solid(60, 90, 200);
    expect(isActiveHand(b, full(b)).value).toBe(true);
  });
  it('暗い紺カード（フォールド）→ 非active', () => {
    const b = solid(20, 40, 110);
    expect(isActiveHand(b, full(b)).value).toBe(false);
  });
  it('紫背景（カード無し）→ 非active', () => {
    const b = solid(100, 45, 130);
    expect(isActiveHand(b, full(b)).value).toBe(false);
  });

  // iOS モード: active カードは bright≈0 だが strong は立つ（実機 active strong≈0.10-0.14 /
  // folded strong≈0.001）。metric='strong' で薄い真の青も active と拾う（bright だと誤 fold）。
  it('metric=strong: 薄い真の青（B>R+50, 但し暗め）→ active（bright は 0 でも）', () => {
    const b = solid(40, 60, 120); // strong 条件を満たすが B<150 なので bright=0
    const frac = blueFractions(b, full(b));
    expect(frac.strong).toBeGreaterThan(0.9);
    expect(frac.bright).toBe(0);
    expect(isActiveHand(b, full(b), { metric: 'bright' }).value).toBe(false); // 旧 Android ルール=誤 fold
    expect(isActiveHand(b, full(b), { metric: 'strong', activeFrac: 0.05 }).value).toBe(true);
  });
});

describe('pickHandActiveRule', () => {
  // 実測値（ディレクター計測, 本番アンカー経路の cardRect）:
  //  Android: active strong 0.4274-0.5883 / bright 0.2999-0.4186、folded strong 0.0000-0.4777 / bright 常に 0.0000。
  //  iOS:     active strong 0.2023-0.3461 / bright 常に 0.0000、       folded strong 0.0000-0.0889 / bright 0.0000。
  it('いずれかの席で bright≥0.06 なら Android 系 → bright/0.06', () => {
    const fracs: BlueFractions[] = [
      { strong: 0.4274, bright: 0.2999 }, // active
      { strong: 0.4777, bright: 0 },       // folded（strong は高いが bright は 0）
      { strong: 0, bright: 0 },            // folded
    ];
    expect(pickHandActiveRule(fracs)).toEqual({ metric: 'bright', threshold: 0.06 });
  });

  it('全席 bright<0.06（iOS の沈んだ青）なら strong/0.15', () => {
    const fracs: BlueFractions[] = [
      { strong: 0.2023, bright: 0 }, // active（iOS 実測最小）
      { strong: 0.3461, bright: 0 }, // active
      { strong: 0.0889, bright: 0 }, // folded（iOS 実測最大）
      { strong: 0, bright: 0 },      // folded
    ];
    expect(pickHandActiveRule(fracs)).toEqual({ metric: 'strong', threshold: 0.15 });
  });

  it('空配列（対象席なし）は既定の Android ルールにフォールバック（回帰ゼロ）', () => {
    expect(pickHandActiveRule([])).toEqual({ metric: 'bright', threshold: 0.06 });
  });

  it('iOS ルールで実測の active/folded 境界を正しく分離する', () => {
    const rule = pickHandActiveRule([
      { strong: 0.2023, bright: 0 },
      { strong: 0.0889, bright: 0 },
    ]);
    const active = solid(40, 60, 160); // strong 高 (B>R+50)・bright は B<150 なので 0 相当の想定
    expect(isActiveHand(active, full(active), { metric: rule.metric, activeFrac: rule.threshold }).value).toBe(true);
    const folded = solid(20, 30, 40); // strong 条件を満たさない暗色 → strong≈0
    expect(isActiveHand(folded, full(folded), { metric: rule.metric, activeFrac: rule.threshold }).value).toBe(false);
  });
});
