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
import type { Rect } from './types.js';
import type { Rgba } from './color.js';
import type { FrameProfile, SeatProfile } from './frameProfile.js';
import type { FracPoint } from './button.js';
import type { Template } from './match.js';
import { recognizeAmount } from './numberField.js';
import { resampleRgba } from './resize.js';

/** 較正解像度（横）。extractRawReadsAuto と一致させる。 */
export const CANON_W = 2730;

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

/** 画素矩形で切り出す（原画像から）。 */
function cropPx(img: Rgba, r: Rect): Rgba {
  const x0 = Math.max(0, Math.min(img.w - 1, r.x));
  const y0 = Math.max(0, Math.min(img.h - 1, r.y));
  const w = Math.max(1, Math.min(img.w - x0, r.w));
  const h = Math.max(1, Math.min(img.h - y0, r.h));
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srow = (y0 + y) * img.w;
    for (let x = 0; x < w; x++) {
      const s = (srow + x0 + x) * 4;
      const d = (y * w + x) * 4;
      data[d] = img.data[s]!;
      data[d + 1] = img.data[s + 1]!;
      data[d + 2] = img.data[s + 2]!;
      data[d + 3] = 255;
    }
  }
  return { w, h, data };
}

/**
 * 領域を cr へ写像→原画像から切り出し→較正解像度で占めるべき画素サイズへ拡大してから
 * NCC 認識し、Read（値＋信頼度）を返す。**低解像度対応**: 検出も抽出（拡大後に読む）と
 * 同じグリフスケールで判定でき、縮小画像のまま読んで外す従来の弱点を解消する。
 * canonH は cr が canonical アスペクトを保つ前提。
 */
function recognizeNorm(
  img: Rgba,
  orig: FracRect,
  cr: ContentRect,
  canonW: number,
  canonH: number,
  digits: readonly Template[],
  minCh?: number,
): { value: number; conf: number } {
  const mapped = mapFrac(orig, cr);
  const rp = toPx(mapped, img.w, img.h);
  if (rp.w <= 2 || rp.h <= 2) return { value: NaN, conf: 0 };
  const crop = cropPx(img, rp);
  const tw = Math.max(4, Math.round(orig.w * canonW));
  const th = Math.max(4, Math.round(orig.h * canonH));
  const up = resampleRgba(crop, tw, th);
  return recognizeAmount(up, { x: 0, y: 0, w: tw, h: th }, digits, minCh !== undefined ? { minCh } : {});
}

function readsDigitsNorm(
  img: Rgba,
  orig: FracRect,
  cr: ContentRect,
  canonW: number,
  canonH: number,
  digits: readonly Template[],
  minCh?: number,
): boolean {
  return Number.isFinite(recognizeNorm(img, orig, cr, canonW, canonH, digits, minCh).value);
}

/** cr の自己整合スコア: スタックが実認識できる席数（0..席数, 整数）。Android 高速パス判定用。 */
export function scoreContentRect(
  img: Rgba,
  profile: FrameProfile,
  cr: ContentRect,
  digits: readonly Template[],
  canonW: number = CANON_W,
  canonH: number = Math.round(CANON_W / profile.aspect),
): number {
  let s = 0;
  for (const seat of profile.seats)
    if (readsDigitsNorm(img, seat.stack, cr, canonW, canonH, digits, seat.stackMinCh)) s++;
  return s;
}

/**
 * cr のランキング用スコア（信頼度加重）。スタックだけでなく **pot / blinds / ante** も
 * アンカーに含め、実際に読めた値の信頼度を合算する。単なる finite 数だと「位置ズレでも
 * finite なゴミ」を拾って最適 cr を外すため、信頼度和で真の整列位置を選ぶ。pot を含める
 * ことで pot が読める cr を優先でき、実機 iPhone の pot 欠落（→棄却）を避けられる。
 */
function scoreCr(
  img: Rgba,
  profile: FrameProfile,
  cr: ContentRect,
  canonW: number,
  canonH: number,
  digits: readonly Template[],
): number {
  let s = 0;
  const add = (r: { value: number; conf: number }) => {
    if (Number.isFinite(r.value)) s += r.conf;
  };
  for (const seat of profile.seats) add(recognizeNorm(img, seat.stack, cr, canonW, canonH, digits, seat.stackMinCh));
  // ヘッダ・中央のアンカー（位置整合の強い手掛かり）。
  add(recognizeNorm(img, profile.pot, cr, canonW, canonH, digits));
  add(recognizeNorm(img, profile.blindsNum, cr, canonW, canonH, digits));
  add(recognizeNorm(img, profile.ante, cr, canonW, canonH, digits));
  return s;
}

/**
 * 「フィット矩形」: canonical アスペクトを保ったまま画面に内接させた content 矩形
 * （scale=1・中央寄せ）。アスペクトが一致する機種は全画面、広い機種はピラーボックス
 * （左右に余白）、狭い機種はレターボックス（上下に余白）になる。拡大時の縦横歪みを防ぐ。
 */
function fitRect(img: Rgba, canonAspect: number, scale: number, dx: number, dy: number): ContentRect {
  const fitWpx = Math.min(img.w, img.h * canonAspect);
  const fitHpx = fitWpx / canonAspect;
  const w = (scale * fitWpx) / img.w;
  const h = (scale * fitHpx) / img.h;
  return { x: (1 - w) / 2 + dx, y: (1 - h) / 2 + dy, w, h };
}

/**
 * レターボックス/ピラーボックスの黒帯を除いた content 矩形を検出。
 * ゲーム描画が画面を満たさない機種（ブラウザ版は 16:9 で描画し左右に黒帯）では、
 * ほぼ純黒（各チャンネル<20）で埋まった端の行/列を帯とみなして除く。テンプレ非依存で
 * レイアウトにも依存しない強い信号。帯が無ければ全画面を返す。
 */
export function detectContentBox(img: Rgba, darkMax = 20, fillFrac = 0.9): ContentRect {
  const { w, h, data } = img;
  const isDark = (x: number, y: number): boolean => {
    const i = (y * w + x) * 4;
    return Math.max(data[i]!, data[i + 1]!, data[i + 2]!) < darkMax;
  };
  const colDark = (x: number): boolean => {
    let c = 0;
    for (let y = 0; y < h; y++) if (isDark(x, y)) c++;
    return c / h > fillFrac;
  };
  const rowDark = (y: number): boolean => {
    let c = 0;
    for (let x = 0; x < w; x++) if (isDark(x, y)) c++;
    return c / w > fillFrac;
  };
  let x0 = 0;
  while (x0 < w - 1 && colDark(x0)) x0++;
  let x1 = w - 1;
  while (x1 > x0 && colDark(x1)) x1--;
  let y0 = 0;
  while (y0 < h - 1 && rowDark(y0)) y0++;
  let y1 = h - 1;
  while (y1 > y0 && rowDark(y1)) y1--;
  return { x: x0 / w, y: y0 / h, w: (x1 - x0 + 1) / w, h: (y1 - y0 + 1) / h };
}

export interface DetectContentRectOptions {
  /** スケール候補（フィット矩形基準）。既定 [0.96..1.03]。 */
  readonly scales?: readonly number[];
  /** オフセット候補（x,y 共通, フィット矩形の中心からのズレ）。既定 [-0.02..0.02]。 */
  readonly offsets?: readonly number[];
}

/**
 * コンテンツ矩形を自動検出。
 *  1) **黒帯検出**で content box を求める。左右/上下に帯がある（ブラウザ版=16:9 を
 *     ピラーボックス）か、box のアスペクトが較正版と大きく違う（SE 等 16:9 全画面）場合は、
 *     その box を返す（切り出し→canonical へ拡大で 16:9→21:9 の圧縮を復元）。
 *  2) 帯が無く box がほぼ全画面＝較正版と同アスペクト（実機 iPhone/Android）は、
 *     アスペクト整合フィット矩形でスケール・オフセットを少数総当りし、スタック実認識
 *     スコア最大の cr を返す（わずかなセーフエリア内寄せを吸収）。全画面満点なら即返す。
 */
export function detectContentRect(
  img: Rgba,
  profile: FrameProfile,
  digits: readonly Template[],
  opts: DetectContentRectOptions = {},
): ContentRect {
  const perfect = profile.seats.length;
  const canonAspect = profile.aspect;
  const canonW = CANON_W;
  const canonH = Math.round(CANON_W / canonAspect);

  // 1) 黒帯検出。帯があるか、box アスペクトが較正版と大きく違えばそれを採用。
  const box = detectContentBox(img);
  const hasBars = box.w < 0.98 || box.h < 0.98;
  const boxAspect = (box.w * img.w) / (box.h * img.h);
  const aspectOff = Math.abs(boxAspect - canonAspect) / canonAspect > 0.05;
  if (hasBars || aspectOff) return box;

  // 2) 帯無し・較正版アスペクト（実機 iPhone/Android）。全画面が全席読めれば即採用（高速パス）。
  if (scoreContentRect(img, profile, FULL_FRAME, digits, canonW, canonH) >= perfect) return FULL_FRAME;

  // フィット矩形を基準にスケール・オフセットを総当り、**信頼度加重スコア**最大の cr を選ぶ。
  // 実機 iPhone はセーフエリアで最大 ±4% 内寄せ（y は負方向にも）ずれるため広めに探る。
  const scales = opts.scales ?? [0.94, 0.96, 0.98, 1.0, 1.02];
  const offsets = opts.offsets ?? [-0.04, -0.03, -0.02, -0.01, 0, 0.01, 0.02, 0.03, 0.04];
  // **全画面を基準に、有意に上回る cr のみ採用**（マージン）。アスペクトが合う機種
  // （Android/実機）は全画面がほぼ最適なので、僅差のズレ候補で全画面を上書きさせない
  // （＝Android 回帰防止）。実機 iPhone のように全画面が大きく外れる場合のみ内寄せ cr を選ぶ。
  const MARGIN = 0.75;
  const fullScore = scoreCr(img, profile, FULL_FRAME, canonW, canonH, digits);
  let best: ContentRect = FULL_FRAME;
  let bestScore = fullScore + MARGIN;
  for (const sc of scales)
    for (const ox of offsets)
      for (const oy of offsets) {
        const cr = fitRect(img, canonAspect, sc, ox, oy);
        const s = scoreCr(img, profile, cr, canonW, canonH, digits);
        if (s > bestScore) {
          bestScore = s;
          best = cr;
        }
      }
  return best;
}
