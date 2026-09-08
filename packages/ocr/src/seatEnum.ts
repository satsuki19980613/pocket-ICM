/**
 * 席列挙（アンカー方式・OCR_PHASE2 §B3 の核）。本番未接続の Phase 2 基盤。
 *
 * 目的: 「黄色 1 塊 = 1 席」の素朴判定は弱すぎる（バナー/HUD/D ディスク/レベル表記の黄色を
 * 拾って過剰、暗い折れ名で過少 → 6→5 の再発）。**複数信号の合議**で 6 スロット
 * [TL,TC,TR,BR,BC,BL] の占有を決める:
 *   1. アバター/プレート（テーブル外周の顔絵）の存在 = 名前アンカー箱のエッジ密度、
 *   2. その直下の黄色いプレイヤー名（detectYellowName と同じ黄色レンジの全画面塊検出）、
 *   3. 名前がテーブル楕円の外周リング上にある（上部バナー・中央 Pot/ボード帯・下部再生 UI を
 *      幾何で除外）、
 *   4. 検出塊を席角度（＝席アンカー最近傍）で 6 スロットへ整列。1 スロット最尤 1、無候補は empty。
 *   5. hero = 最下段中央 BC（金枠プレート＋表向きカード）で特定。
 *
 * アンカーはゲームのレイアウト比（横 ~2.16）で較正した**フラクショナル**座標。実測で
 * Android(2730)・iOS(1792)・劣化(1310, 比 2.44)の全席名がこの相対位置に落ちることを確認済み
 * （scripts/_SEATENUM_RESULTS.md）。フラクショナルなので拡大正規化（§B2）で不変。
 */

import type { Rect } from './types.js';
import type { Rgba } from './color.js';
import { isYellowNamePixel, edgeDensity } from './seatPresence.js';
import { grayFromRgba, whiteMask, binaryComponents } from './numberField.js';
import { normalizeForAnchors } from './upscaleNormalize.js';

/** 画面席（固定位置・時計回り）。frameProfile.ScreenSeat と一致。 */
export type Slot = 'TL' | 'TC' | 'TR' | 'BR' | 'BC' | 'BL';
export const SLOTS: readonly Slot[] = ['TL', 'TC', 'TR', 'BR', 'BC', 'BL'];

/** 席名アンカー（画像に対するフラクショナル中心）。Android/iOS/劣化の名前重心の合議値。 */
export const SLOT_ANCHORS: Record<Slot, { x: number; y: number }> = {
  TL: { x: 0.268, y: 0.288 },
  TC: { x: 0.522, y: 0.196 },
  TR: { x: 0.800, y: 0.286 },
  BR: { x: 0.847, y: 0.644 },
  BC: { x: 0.620, y: 0.782 }, // hero
  BL: { x: 0.216, y: 0.642 },
};

/** テーブル中心（リング位相の原点）。 */
export const TABLE_CENTER = { x: 0.5, y: 0.44 };

/** 幾何除外帯（フラクショナル）: 上部バナー / 下部再生 UI / 中央 Pot・ボード帯。 */
const BANNER_MAX_CY = 0.135;
const BOTTOM_UI_MIN_CY = 0.82;
const CENTER_BAND = { xr: 0.13, y0: 0.30, y1: 0.58 };

/** 非 hero スロット割当ての最大アンカー距離（フラクショナル）。実測名前距離 max ~0.033。 */
const MAX_DIST = 0.06;
/** hero(BC) は金枠のみ検出で重心がずれるため広め。 */
const MAX_DIST_HERO = 0.10;
/** 黄色名塊とみなす最小画素数（劣化 1310 の微弱名 ~55px も拾う下限, 拡大前基準は使わない）。 */
const MIN_NAME_INK_FRAC = 0.0000015; // × (w*h)
/** アバター/プレート・エッジ密度の占有下限（empty felt ~0 vs occupied 高, seatPresence 実測）。 */
const AVATAR_EDGE_FRAC = 0.05;

export interface YellowBlob {
  /** 重心（フラクショナル）。 */
  readonly cx: number;
  readonly cy: number;
  /** 黄色画素数（拡大後画像基準）。 */
  readonly ink: number;
  /** 外接ボックス（px, 拡大後画像座標）。 */
  readonly box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  /** 外接ボックス寸法（フラクショナル）。 */
  readonly fw: number;
  readonly fh: number;
}

/**
 * 画面全体の黄色名塊を検出する（横方向に閉じて語塊化 → 8 連結）。
 * detectYellowName（席矩形ローカル）と同じ黄色レンジ（isYellowNamePixel）を全画面に適用する。
 */
export function yellowNameBlobs(img: Rgba): YellowBlob[] {
  const { w, h, data } = img;
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      if (isYellowNamePixel(data[s]!, data[s + 1]!, data[s + 2]!)) mask[y * w + x] = 1;
    }
  // 文字間を横方向に橋渡しして語塊にまとめる（幅の 1.2%）。
  const r = Math.max(2, Math.round(w * 0.012));
  const dil = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let run = 0;
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) run = r;
      if (run > 0) { dil[y * w + x] = 1; run--; }
    }
    for (let x = w - 1; x >= 0; x--) if (mask[y * w + x]) for (let k = 1; k <= r && x + k < w; k++) dil[y * w + x + k] = 1;
  }
  const seen = new Uint8Array(w * h);
  const st: number[] = [];
  const out: YellowBlob[] = [];
  const minInk = Math.max(12, Math.round(w * h * MIN_NAME_INK_FRAC));
  for (let i = 0; i < w * h; i++) {
    if (!dil[i] || seen[i]) continue;
    st.length = 0; st.push(i); seen[i] = 1;
    let x0 = w, y0 = h, x1 = -1, y1 = -1, sx = 0, sy = 0, area = 0, ink = 0;
    while (st.length) {
      const p = st.pop()!; const px = p % w, py = (p / w) | 0;
      area++; sx += px; sy += py;
      if (mask[p]) ink++;
      if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
      const nb = [p - 1, p + 1, p - w, p + w];
      for (const q of nb) {
        if (q < 0 || q >= w * h || !dil[q] || seen[q]) continue;
        if (Math.abs((q % w) - px) > 1) continue;
        seen[q] = 1; st.push(q);
      }
    }
    if (ink < minInk) continue;
    out.push({
      cx: (sx / area) / w, cy: (sy / area) / h, ink,
      box: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 },
      fw: (x1 - x0 + 1) / w, fh: (y1 - y0 + 1) / h,
    });
  }
  return out;
}

/** 幾何ゲート: バナー / 下部 UI / 中央 Pot・ボード帯に入る塊は席名でない。 */
export function isSeatRingBlob(cx: number, cy: number): boolean {
  if (cy < BANNER_MAX_CY) return false; // 上部バナー
  if (cy > BOTTOM_UI_MIN_CY) return false; // 下部再生 UI
  if (Math.abs(cx - 0.5) < CENTER_BAND.xr && cy > CENTER_BAND.y0 && cy < CENTER_BAND.y1) return false; // 中央
  return true;
}

/** アンカー方式で 1 塊を最近傍スロットへ割当てる（距離が閾値超なら null）。 */
export function assignSlot(cx: number, cy: number): { slot: Slot; dist: number } | null {
  let best: { slot: Slot; dist: number } | null = null;
  for (const slot of SLOTS) {
    const a = SLOT_ANCHORS[slot];
    const d = Math.hypot(a.x - cx, a.y - cy);
    if (best === null || d < best.dist) best = { slot, dist: d };
  }
  if (!best) return null;
  const cap = best.slot === 'BC' ? MAX_DIST_HERO : MAX_DIST;
  return best.dist <= cap ? best : null;
}

/** スロットのアバター/プレート箱（名前アンカー中心の小箱, エッジ密度用）。 */
function avatarBox(img: Rgba, slot: Slot): Rect {
  const a = SLOT_ANCHORS[slot];
  const bw = 0.085, bh = 0.05;
  const x = Math.round((a.x - bw / 2) * img.w);
  const y = Math.round((a.y - bh / 2) * img.h);
  return { x, y, w: Math.round(bw * img.w), h: Math.round(bh * img.h) };
}

/** hero(BC) の表向きカード帯に白カード矩形が 2 枚検出できるか（金枠に依らない在席補強）。 */
function heroCardsPresent(img: Rgba): boolean {
  // 名前アンカーの上（カードは名前の上・中央）。較正比の hero カード帯 ~ (0.46..0.55, 0.60..0.78)。
  const rect: Rect = {
    x: Math.round(0.40 * img.w), y: Math.round(0.60 * img.h),
    w: Math.round(0.20 * img.w), h: Math.round(0.16 * img.h),
  };
  const g = grayFromRgba(img, rect);
  const mask = whiteMask(img, rect, { minCh: 170, maxSat: 60 });
  // 白い大きめの連結成分が 2 つ以上（カード）。binaryComponents は面積・高さで小片を落とす。
  const comps = binaryComponents(mask).filter((c) => c.w * c.h >= 0.02 * g.w * g.h);
  return comps.length >= 2;
}

export interface SeatSlot {
  readonly slot: Slot;
  readonly occupied: boolean;
  readonly isHero: boolean;
  /** 検出した黄色名ボックス（px, 拡大後座標）。占有かつ黄色名が取れた席のみ。 */
  readonly nameBox?: { readonly cx: number; readonly cy: number; readonly top: number; readonly bottom: number; readonly h: number };
  /** 占有判定の内訳（診断用）。 */
  readonly signals: { readonly yellowInk: number; readonly yellowDist: number; readonly avatarEdge: number; readonly heroCards?: boolean };
}

export interface SeatEnumResult {
  readonly seats: readonly SeatSlot[]; // 常に 6（[TL,TC,TR,BR,BC,BL] 順）
  readonly playersLeft: number;
  /** 適用した拡大倍率（§B2）。 */
  readonly scale: number;
}

/**
 * 6 スロットの占有を列挙する（§B3 の合議モデル）。返り値は常に 6 席（[TL,TC,TR,BR,BC,BL]）。
 * 前段に normalizeForAnchors（§B2）を適用してから幾何処理する。
 */
export function enumerateSeats(imgIn: Rgba): SeatEnumResult {
  const { img, scale } = normalizeForAnchors(imgIn);

  // 全画面の黄色塊を検出し、幾何ゲートを通ったものをスロットへ最近傍割当て。
  const blobs = yellowNameBlobs(img).filter((b) => isSeatRingBlob(b.cx, b.cy));
  const bySlot = new Map<Slot, { blob: YellowBlob; dist: number }>();
  for (const b of blobs) {
    const asg = assignSlot(b.cx, b.cy);
    if (!asg) continue;
    const cur = bySlot.get(asg.slot);
    if (!cur || asg.dist < cur.dist) bySlot.set(asg.slot, { blob: b, dist: asg.dist });
  }

  const heroCards = heroCardsPresent(img);

  const seats: SeatSlot[] = SLOTS.map((slot) => {
    const isHero = slot === 'BC';
    const hit = bySlot.get(slot);
    const avatarEdge = edgeDensity(grayFromRgba(img, avatarBox(img, slot)));
    const yellowInk = hit?.blob.ink ?? 0;
    const yellowDist = hit?.dist ?? Infinity;

    // 占有の合議: 黄色名（アンカー近傍）OR アバター/プレートのエッジ密度。
    // hero は金枠のみで黄色名が弱い場合があるので表向きカードも OR。
    let occupied = !!hit || avatarEdge >= AVATAR_EDGE_FRAC;
    if (isHero) occupied = occupied || heroCards;

    const nameBox = hit
      ? {
          cx: hit.blob.box.x + hit.blob.box.w / 2,
          cy: hit.blob.box.y + hit.blob.box.h / 2,
          top: hit.blob.box.y,
          bottom: hit.blob.box.y + hit.blob.box.h,
          h: hit.blob.box.h,
        }
      : undefined;

    return {
      slot, occupied, isHero,
      ...(occupied && nameBox ? { nameBox } : {}),
      signals: { yellowInk, yellowDist, avatarEdge, ...(isHero ? { heroCards } : {}) },
    };
  });

  return { seats, playersLeft: seats.filter((s) => s.occupied).length, scale };
}
