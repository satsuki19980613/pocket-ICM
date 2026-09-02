/**
 * BB 表示（小数）モードの金額リーダ。SPEC §6.2。
 *
 * BB 表示ではスタック/ベット/ポットが "20.2 BB" / "13 BB"（整数値は小数点なし）で描かれ、
 * ヘッダの SB/BB・アンティだけは chips のまま（extract 側で別扱い）。chips モードとの違い:
 *  - 末尾に白文字 "BB" が付く（whiteMask が拾う）→ **スペース（最大ギャップ）で分離**して捨てる。
 *  - 小数点 "." は微小成分（実測 area≈42, h≈7, ベースライン）で、数字と整数の区別
 *    ("13"=13 か "1.3"=1.3 か)に必須 → 面積/高さの下限を下げて **必ず捕捉**する。
 *
 * 手順: whiteMask → 生 CCL（枠線/隅ノイズだけ除去）→ 左→右 → スペースで最初のクラスタ
 * （＝数値）を取り "BB" を捨てる → クラスタ内で背の低い成分は '.'、他は数字 NCC → parseAmount。
 *
 * chips 番号 "13,491" は連続一塊（スペース無し）＝ 1 クラスタなので、**2 クラスタに割れるか
 * どうか**が BB/chips の判別信号にもなる（hasBbSuffix / detectDisplayMode）。
 */

import type { DisplayMode, Gray, Rect, Read } from './types.js';
import type { Rgba } from './color.js';
import { crop, resize } from './raster.js';
import { bestMatch, matchConfidence, type Template } from './match.js';
import { parseAmount } from './digits.js';
import { grayFromRgba, whiteMask, DIGIT_NORM_H, type WhiteMaskOptions } from './numberField.js';

export interface BbAmountOptions extends WhiteMaskOptions {
  /** 数値の下限信頼度（未満なら低信頼フラグ）。既定 0.80。 */
  readonly confFloor?: number;
}

interface RawComp extends Rect {
  readonly area: number;
}

/** 生 CCL（面積/高さフィルタ無し, 4 近傍）。左→右。 */
function rawComponents(bin: Gray): RawComp[] {
  const { w, h, data } = bin;
  if (w === 0 || h === 0) return [];
  const label = new Int32Array(w * h).fill(-1);
  const boxes: { x0: number; y0: number; x1: number; y1: number; area: number }[] = [];
  const st: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (data[i] === 0 || label[i] !== -1) continue;
    const id = boxes.length;
    boxes.push({ x0: w, y0: h, x1: -1, y1: -1, area: 0 });
    st.length = 0; st.push(i); label[i] = id;
    while (st.length) {
      const p = st.pop()!;
      const px = p % w, py = (p / w) | 0;
      const b = boxes[id]!; b.area++;
      if (px < b.x0) b.x0 = px; if (px > b.x1) b.x1 = px;
      if (py < b.y0) b.y0 = py; if (py > b.y1) b.y1 = py;
      if (px > 0 && data[p - 1]! > 0 && label[p - 1] === -1) { label[p - 1] = id; st.push(p - 1); }
      if (px < w - 1 && data[p + 1]! > 0 && label[p + 1] === -1) { label[p + 1] = id; st.push(p + 1); }
      if (py > 0 && data[p - w]! > 0 && label[p - w] === -1) { label[p - w] = id; st.push(p - w); }
      if (py < h - 1 && data[p + w]! > 0 && label[p + w] === -1) { label[p + w] = id; st.push(p + w); }
    }
  }
  return boxes
    .map((b) => ({ x: b.x0, y: b.y0, w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1, area: b.area }))
    .sort((a, b) => a.x - b.x);
}

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/**
 * 数字＋小数点だけを残す（枠線・隅ノイズ・幅広ブロブ・背の高い飾りを除去）。
 * 除去: 面積 < 15 / 高さ < 5 / 幅がストリップ幅の 0.5 超（プレート枠線）/ w:h > 1.6（横線・ブロブ）/
 *       高さが標準グリフの 1.4 倍超（宝石・星の飾り）。標準グリフ高は tall 成分の中央値。
 */
function glyphComponents(mask: Gray): RawComp[] {
  const base = rawComponents(mask).filter(
    (c) => c.area >= 15 && c.h >= 5 && c.w <= 0.5 * mask.w && c.w / c.h <= 1.6,
  );
  if (base.length === 0) return base;
  const maxH = Math.max(...base.map((c) => c.h));
  const glyphH = median(base.filter((c) => c.h >= 0.5 * maxH).map((c) => c.h));
  // 標準グリフより十分高い成分は飾り（BL の宝石/星 h42 vs 数字 h26）。
  return base.filter((c) => c.h <= 1.4 * glyphH);
}


function normGlyph(strip: Gray, r: Rect): Gray {
  const g = crop(strip, r);
  const nw = Math.max(1, Math.round((g.w * DIGIT_NORM_H) / g.h));
  return resize(g, nw, DIGIT_NORM_H);
}

/**
 * BB 表示の金額を読む（"20.2 BB" → 20.2, "13 BB" → 13）。値は表示どおり **BB**（正規化不要）。
 * templates は数字 0-9（'.' は成分の低さで判定するのでテンプレ不要）。
 * 数字が無ければ value=NaN, conf=0。
 */
export function readAmountBb(
  img: Rgba,
  rect: Rect,
  templates: readonly Template[],
  opts: BbAmountOptions = {},
): Read<number> {
  const minCh = opts.minCh ?? 120;
  const maxSat = opts.maxSat ?? 80;
  const strip = grayFromRgba(img, rect);
  const comps = glyphComponents(whiteMask(img, rect, { minCh, maxSat }));
  if (comps.length === 0) return { value: NaN, conf: 0 };
  const maxH = Math.max(...comps.map((c) => c.h));

  // 末尾 "BB" ＝ 背の高い成分ちょうど 2 個（BB 表示は必ずこの接尾辞で終わる）。
  // ギャップ閾値は narrow な "1" で不安定なので使わず、tall の末尾 2 個（BB）を除外し、
  // 数値スパン（先頭桁〜最終桁の x 範囲）内の成分だけを取る（端ノイズ・"Pot :" 等を除去）。
  const tall = comps.filter((c) => c.h >= 0.45 * maxH);
  if (tall.length < 3) return { value: NaN, conf: 0 }; // 数字 1 個 ＋ "BB" 未満は読めない
  const numTall = tall.slice(0, tall.length - 2); // BB を除いた数字（tall）
  const firstX = numTall[0]!.x;
  const lastTall = numTall[numTall.length - 1]!;
  const lastX = lastTall.x + lastTall.w;
  // 数値スパン内の成分（間の小数点を含む。範囲外の端ノイズ／"BB"は除外）。
  const num = comps.filter((c) => c.x >= firstX - 2 && c.x + c.w <= lastX + 2);

  let text = '';
  let minScore = 1;
  for (const c of num) {
    if (c.h < 0.45 * maxH) {
      text += '.'; // 小数点（背が低い成分）
      continue;
    }
    const m = bestMatch(normGlyph(strip, c), templates);
    text += m.label;
    const s = matchConfidence(m);
    if (s < minScore) minScore = s;
  }
  const value = parseAmount(text);
  if (value === null) return { value: NaN, conf: 0 };
  return { value, conf: Math.max(0, Math.min(1, minScore)) };
}

/**
 * スタックの末尾 2 背高成分が "B","B" か（＝BB 表示）を NCC で確認。SPEC §6.2 のモード判定。
 * digits＋letters（"B"）でマッチし、末尾 2 tall が両方 'B' なら true。chips は数字で終わるので false。
 * 実画像 hero 101/101 で chips/BB を完全分離（ピッチ判定より確実）。成分 3 未満は false。
 */
export function stackEndsWithBb(
  img: Rgba,
  rect: Rect,
  digitTemplates: readonly Template[],
  letterTemplates: readonly Template[],
  opts: WhiteMaskOptions = {},
): boolean {
  const minCh = opts.minCh ?? 120;
  const maxSat = opts.maxSat ?? 80;
  const strip = grayFromRgba(img, rect);
  const comps = glyphComponents(whiteMask(img, rect, { minCh, maxSat }));
  if (comps.length < 3) return false;
  const maxH = Math.max(...comps.map((c) => c.h));
  const tall = comps.filter((c) => c.h >= 0.45 * maxH);
  if (tall.length < 3) return false;
  const all = [...digitTemplates, ...letterTemplates];
  const last2 = tall.slice(-2);
  return last2.every((c) => bestMatch(normGlyph(strip, c), all).label === 'B');
}

/**
 * フレームの数値表示モードを判定（'bb' | 'chips'）。SPEC §6.2。
 * hero スタックが最もクリーンなので主判定に使い、読めなければ他の occupied 席を順に見る。
 * どの席も読めなければ chips（既定）にフォールバック。
 */
export function detectDisplayMode(
  img: Rgba,
  stackRects: readonly Rect[],
  digitTemplates: readonly Template[],
  letterTemplates: readonly Template[],
  opts: WhiteMaskOptions = {},
): DisplayMode {
  for (const rect of stackRects) {
    const comps = glyphComponents(whiteMask(img, rect, { minCh: opts.minCh ?? 120, maxSat: opts.maxSat ?? 80 }));
    if (comps.length < 3) continue; // 空席/読めない席は飛ばす
    return stackEndsWithBb(img, rect, digitTemplates, letterTemplates, opts) ? 'bb' : 'chips';
  }
  return 'chips';
}
