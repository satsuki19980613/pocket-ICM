/**
 * マーク探索帯（アスペクト帯 × 席の静的グリッド）のテスト。
 *
 * 座標そのものは実画像で較正した値（`scripts/measureMarkGrid.ts`・サブエージェントの独立計測と
 * 0.0015 以内で一致）。ここでは**選び方と組み立て方**を固定する:
 *   - 較正済みアスペクト帯では静的グリッドを使う（席名検出のブレを受けない）
 *   - 未較正帯では席名アンカー ＋ 相対オフセットへ落ちる（＝従来経路・回帰ゼロ）
 *   - 席名も取れなければ SLOT_ANCHORS へ落ちる
 */
import { describe, it, expect } from 'vitest';
import type { Rgba } from './color.js';
import { SLOT_ANCHORS } from './seatEnum.js';
import {
  MARK_GRID_2P16,
  MARK_ZONE,
  MARK_ZONE_H,
  MARK_ZONE_W,
  markZoneRect,
  pickMarkGrid,
} from './actionMarkZone.js';

/** 画素は見ないので中身は空でよい（幅・高さだけ使う）。 */
const img = (w: number, h: number): Rgba => ({ w, h, data: new Uint8Array(0) });
const center = (r: { x: number; y: number; w: number; h: number }) => ({ cx: r.x + r.w / 2, cy: r.y + r.h / 2 });

describe('pickMarkGrid', () => {
  it('較正済みのアスペクト帯（Android 2730×1260 / iOS 実機 1792×828）でグリッドを返す', () => {
    expect(pickMarkGrid(2730 / 1260)).toBe(MARK_GRID_2P16);
    expect(pickMarkGrid(1792 / 828)).toBe(MARK_GRID_2P16);
  });

  it('未較正の帯では undefined（＝席名アンカーへ落ちる）', () => {
    expect(pickMarkGrid(2424 / 1080)).toBeUndefined(); // Pixel 実機 2.2444
    expect(pickMarkGrid(1334 / 750)).toBeUndefined(); // iPhone SE シミュレータ 1.7787
  });

  it('グリッドは左右対称（卓の中心軸に乗る）', () => {
    const g = MARK_GRID_2P16;
    const axis = g.TC!.cx;
    expect((g.TL!.cx + g.TR!.cx) / 2).toBeCloseTo(axis, 2);
    expect((g.BL!.cx + g.BR!.cx) / 2).toBeCloseTo(axis, 2);
    expect(g.TL!.cy).toBeCloseTo(g.TR!.cy, 3);
    expect(g.BL!.cy).toBeCloseTo(g.BR!.cy, 3);
  });
});

describe('markZoneRect', () => {
  const i = img(2730, 1260);

  it('グリッドがあればその座標を中心に、既定の寸法で帯を作る', () => {
    const r = markZoneRect(i, 'TR', undefined, MARK_GRID_2P16);
    // 帯の中心は丸めの分だけずれるので 1px の許容で見る。
    expect(Math.abs(center(r).cx - MARK_GRID_2P16.TR!.cx * i.w)).toBeLessThanOrEqual(1);
    expect(Math.abs(center(r).cy - MARK_GRID_2P16.TR!.cy * i.h)).toBeLessThanOrEqual(1);
    expect(r.w).toBe(Math.round(MARK_ZONE_W * i.w));
    expect(r.h).toBe(Math.round(MARK_ZONE_H * i.h));
  });

  it('グリッドが無ければ席名ボックス ＋ 相対オフセット', () => {
    const nameBox = { cx: 2000, cy: 900 };
    const r = markZoneRect(i, 'BR', nameBox, undefined);
    expect(center(r).cx).toBeCloseTo(nameBox.cx + MARK_ZONE.BR.dx * i.w, 0);
    expect(center(r).cy).toBeCloseTo(nameBox.cy + MARK_ZONE.BR.dy * i.h, 0);
  });

  it('席名も無ければ SLOT_ANCHORS ＋ 相対オフセット', () => {
    const r = markZoneRect(i, 'BL', undefined, undefined);
    expect(center(r).cx).toBeCloseTo((SLOT_ANCHORS.BL.x + MARK_ZONE.BL.dx) * i.w, 0);
    expect(center(r).cy).toBeCloseTo((SLOT_ANCHORS.BL.y + MARK_ZONE.BL.dy) * i.h, 0);
  });

  it('グリッドに無い席（hero）だけ席名アンカーへ落ちる', () => {
    const nameBox = { cx: 1700, cy: 985 };
    const r = markZoneRect(i, 'BC', nameBox, MARK_GRID_2P16);
    expect(MARK_GRID_2P16.BC).toBeUndefined();
    expect(center(r).cx).toBeCloseTo(nameBox.cx + MARK_ZONE.BC.dx * i.w, 0);
  });

  it('帯はプレート実寸（0.054×0.042）より十分広い（テーマ差 0.027 を吸収する）', () => {
    expect(MARK_ZONE_W - 0.054).toBeGreaterThan(2 * 0.027);
  });

  it('フラクショナル指定なので解像度が変わっても同じ相対位置になる', () => {
    const a = markZoneRect(img(2730, 1260), 'TL', undefined, MARK_GRID_2P16);
    const b = markZoneRect(img(1792, 828), 'TL', undefined, MARK_GRID_2P16);
    expect(center(a).cx / 2730).toBeCloseTo(center(b).cx / 1792, 3);
    expect(center(a).cy / 1260).toBeCloseTo(center(b).cy / 828, 3);
  });
});
