/**
 * seatEnum（§B3）の単体テスト（画像非依存の合成画像）。
 * 実フレームでの席列挙精度は scripts/_SEATENUM_RESULTS.md（26 実フレーム＋劣化 1310 で playersLeft 完全一致）。
 * ここでは幾何フィルタ（バナー/中央/下部 UI 除外・角度スロット割当て）と、黄色名からの占有合議を固定する。
 */
import { describe, it, expect } from 'vitest';
import type { Rgba } from './color.js';
import {
  enumerateSeats, isSeatRingBlob, assignSlot, yellowNameBlobs,
  SLOT_ANCHORS, type Slot,
} from './seatEnum.js';

const YELLOW = { r: 255, g: 200, b: 0 };

/** felt 一様背景（エッジ密度≈0）に、指定スロット重心へ黄色名バーを描く合成フレーム（比 ~2.16）。 */
function tableWithNames(slots: Slot[], w = 1200, h = 555): Rgba {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[i * 4] = 30; data[i * 4 + 1] = 90; data[i * 4 + 2] = 60; data[i * 4 + 3] = 255; }
  const barW = Math.round(w * 0.07), nameH = 26;
  for (const slot of slots) {
    const a = SLOT_ANCHORS[slot];
    const x0 = Math.round(a.x * w - barW / 2), y0 = Math.round(a.y * h - nameH / 2);
    for (let y = y0; y < y0 + nameH; y++)
      for (let x = x0; x < x0 + barW; x++) {
        if (y < 0 || y >= h || x < 0 || x >= w) continue;
        const s = (y * w + x) * 4; data[s] = YELLOW.r; data[s + 1] = YELLOW.g; data[s + 2] = YELLOW.b;
      }
  }
  return { w, h, data };
}

describe('isSeatRingBlob (geometry gates)', () => {
  it('rejects blobs in the top banner region', () => {
    expect(isSeatRingBlob(0.075, 0.082)).toBe(false); // 左上バナー（レベル/ブラインド）
  });
  it('rejects blobs in the bottom replay-control UI', () => {
    expect(isSeatRingBlob(0.6, 0.936)).toBe(false);
  });
  it('rejects blobs in the central Pot/board band', () => {
    expect(isSeatRingBlob(0.5, 0.40)).toBe(false);
  });
  it('accepts real seat-ring positions', () => {
    expect(isSeatRingBlob(SLOT_ANCHORS.TL.x, SLOT_ANCHORS.TL.y)).toBe(true);
    expect(isSeatRingBlob(SLOT_ANCHORS.BR.x, SLOT_ANCHORS.BR.y)).toBe(true);
    expect(isSeatRingBlob(SLOT_ANCHORS.BC.x, SLOT_ANCHORS.BC.y)).toBe(true);
  });
});

describe('assignSlot (angular ring mapping)', () => {
  it('maps a point at a slot anchor to that slot', () => {
    for (const slot of ['TL', 'TC', 'TR', 'BR', 'BC', 'BL'] as Slot[]) {
      const a = SLOT_ANCHORS[slot];
      expect(assignSlot(a.x, a.y)?.slot).toBe(slot);
    }
  });
  it('rejects a point far from every seat (table center)', () => {
    expect(assignSlot(0.5, 0.44)).toBeNull();
  });
  it('rejects the top banner corner (no nearby seat within cap)', () => {
    expect(assignSlot(0.075, 0.082)).toBeNull();
  });
  it('picks the nearest slot for a slightly offset name', () => {
    const a = SLOT_ANCHORS.TR;
    expect(assignSlot(a.x - 0.02, a.y + 0.01)?.slot).toBe('TR');
  });
});

describe('yellowNameBlobs', () => {
  it('finds one blob per drawn name and rejects empty felt', () => {
    const blobs = yellowNameBlobs(tableWithNames(['TL', 'TR', 'BC']));
    expect(blobs.length).toBe(3);
    // 全塊が席リング内に落ちる。
    for (const b of blobs) expect(isSeatRingBlob(b.cx, b.cy)).toBe(true);
  });
});

describe('enumerateSeats (consensus occupancy)', () => {
  it('always returns 6 slots in canonical order', () => {
    const res = enumerateSeats(tableWithNames(['BC']));
    expect(res.seats.map((s) => s.slot)).toEqual(['TL', 'TC', 'TR', 'BR', 'BC', 'BL']);
  });

  it('counts exactly the occupied slots and no banner/center over-count', () => {
    const res = enumerateSeats(tableWithNames(['TL', 'TC', 'BC']));
    const occ = new Set(res.seats.filter((s) => s.occupied).map((s) => s.slot));
    expect(res.playersLeft).toBe(3);
    expect([...occ].sort()).toEqual(['BC', 'TC', 'TL']);
  });

  it('leaves slots with no name/avatar signal empty (no under/over-count on uniform felt)', () => {
    const res = enumerateSeats(tableWithNames(['TC', 'TR', 'BR', 'BC']));
    expect(res.playersLeft).toBe(4);
    expect(res.seats.find((s) => s.slot === 'TL')!.occupied).toBe(false);
    expect(res.seats.find((s) => s.slot === 'BL')!.occupied).toBe(false);
  });

  it('marks hero at the BC slot', () => {
    const res = enumerateSeats(tableWithNames(['BC']));
    const hero = res.seats.find((s) => s.isHero)!;
    expect(hero.slot).toBe('BC');
    expect(hero.occupied).toBe(true);
  });
});
