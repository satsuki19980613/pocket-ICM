/**
 * コンテンツ矩形（プレイエリア）による座標正規化と自動検出。SPEC §6.2 拡張（多機種対応）。
 *
 * FrameProfile の割合座標は「画面全体」基準で 1 機種（2730×1260）に固定較正されている。
 * 機種によってはゲーム描画が iOS セーフエリア等により画面内の部分矩形へ収まる
 * （実測: iPhone 1792×828 は scale≈0.9・offset≈(0.03,0.015) の**一様アフィン**）。そこで
 * 「コンテンツ矩形」cr を導入し、全領域を cr の中へ写像する。cr=全画面なら従来と完全一致
 * （Android 2730×1260 は無影響）。
 *
 * 自動検出は「候補 cr を総当りし、スタック/ブラインド領域に数字成分が最も多く載る cr を選ぶ」
 * 自己整合スコアで行う（テーマ非依存・テンプレ不要の軽量指標）。機種差が一様アフィンである
 * 実証（calibSearch: iPhone で 6/6・hero 読取）に基づく。アスペクトが大きく異なる機種は
 * 一様スケールでは吸収しきれない（将来: 非一様 or 較正 UI）。
 */

import type { FracRect } from './layout.js';
import { toPx } from './layout.js';
import type { Rgba } from './color.js';
import type { FrameProfile, SeatProfile } from './frameProfile.js';
import type { FracPoint } from './button.js';
import type { Template } from './match.js';
import { recognizeAmount } from './numberField.js';

/** ゲーム内容が画面内で占める割合矩形。既定は全画面。 */
export type ContentRect = FracRect;
export const FULL_FRAME: ContentRect = { x: 0, y: 0, w: 1, h: 1 };

export function isFullFrame(cr: ContentRect): boolean {
  return cr.x === 0 && cr.y === 0 && cr.w === 1 && cr.h === 1;
}

/** 割合矩形を cr の中へ写像（x' = cr.x + x*cr.w など）。 */
export function mapFrac(r: FracRect, cr: ContentRect): FracRect {
  return { x: cr.x + r.x * cr.w, y: cr.y + r.y * cr.h, w: r.w * cr.w, h: r.h * cr.h };
}

function mapPoint(p: FracPoint, cr: ContentRect): FracPoint {
  return { x: cr.x + p.x * cr.w, y: cr.y + p.y * cr.h };
}

/** プロファイル全体を cr の中へ写像。cr=全画面なら同一参照を返す（Android 高速パス）。 */
export function mapProfile(profile: FrameProfile, cr: ContentRect): FrameProfile {
  if (isFullFrame(cr)) return profile;
  const s = (seat: SeatProfile): SeatProfile => ({
    ...seat,
    stack: mapFrac(seat.stack, cr),
    bet: mapFrac(seat.bet, cr),
    betBb: seat.betBb ? mapFrac(seat.betBb, cr) : undefined,
    card: mapFrac(seat.card, cr),
    actionZone: mapFrac(seat.actionZone, cr),
    buttonAnchor: mapPoint(seat.buttonAnchor, cr),
  });
  return {
    ...profile,
    blindsNum: mapFrac(profile.blindsNum, cr),
    ante: mapFrac(profile.ante, cr),
    pot: mapFrac(profile.pot, cr),
    board: mapFrac(profile.board, cr),
    heroCards: mapFrac(profile.heroCards, cr),
    table: mapFrac(profile.table, cr),
    seats: profile.seats.map(s),
  };
}

/**
 * 領域に「認識できる数値」が載るか（デジット NCC で実認識, finite なら 1）。
 * 単なる成分の有無ではなく実際に数字として読めるかを見る（装飾の誤検出を避ける）。
 * BB 表示（"19.2 BB"）でも先頭の数値部は chips 認識で finite になるので位置合わせ指標に足る。
 */
function readsDigits(img: Rgba, f: FracRect, digits: readonly Template[], minCh?: number): boolean {
  const rect = toPx(f, img.w, img.h);
  if (rect.w <= 2 || rect.h <= 2) return false;
  return Number.isFinite(recognizeAmount(img, rect, digits, minCh !== undefined ? { minCh } : {}).value);
}

/** cr の自己整合スコア: 数値が実認識できるスタック席数（0..席数）。 */
export function scoreContentRect(
  img: Rgba,
  profile: FrameProfile,
  cr: ContentRect,
  digits: readonly Template[],
): number {
  const p = mapProfile(profile, cr);
  let s = 0;
  for (const seat of p.seats) if (readsDigits(img, seat.stack, digits, seat.stackMinCh)) s++;
  return s;
}

export interface DetectContentRectOptions {
  /** 一様スケール候補。既定 [0.86..1.0]。 */
  readonly scales?: readonly number[];
  /** オフセット候補（x,y 共通）。既定 [-0.03..0.08]。 */
  readonly offsets?: readonly number[];
}

/**
 * コンテンツ矩形を自動検出。全画面が満点（全席）なら即返す（Android 高速パス）。
 * そうでなければ一様スケール＋オフセットを総当りし、実認識スコア最大の cr を返す
 * （全画面も候補なので、優劣が無ければ全画面が残る）。digits テンプレが必要。
 */
export function detectContentRect(
  img: Rgba,
  profile: FrameProfile,
  digits: readonly Template[],
  opts: DetectContentRectOptions = {},
): ContentRect {
  const perfect = profile.seats.length;
  const full = scoreContentRect(img, profile, FULL_FRAME, digits);
  if (full >= perfect) return FULL_FRAME;

  const scales = opts.scales ?? [0.86, 0.9, 0.94, 0.98, 1.0];
  const offsets = opts.offsets ?? [-0.03, 0, 0.015, 0.03, 0.05, 0.08];
  let best: ContentRect = FULL_FRAME;
  let bestScore = full;
  for (const sc of scales)
    for (const ox of offsets)
      for (const oy of offsets) {
        const cr: ContentRect = { x: ox, y: oy, w: sc, h: sc };
        const s = scoreContentRect(img, profile, cr, digits);
        if (s > bestScore) {
          bestScore = s;
          best = cr;
        }
      }
  return best;
}
