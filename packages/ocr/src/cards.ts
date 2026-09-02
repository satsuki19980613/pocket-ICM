/**
 * カード認識（52 種テンプレートマッチ＋ハンドクラス組み立て）。SPEC §6.3 #1。
 *
 * カード表面デザインは全プレイヤー・全装飾品で統一（§5.1 確認済み）なので、
 * 52 枚のテンプレへの NCC マッチで足りる。テンプレは利用者スクショから初回生成
 * （§10 / R-10、リポジトリに含めない）。ここでは 2 枚 → ハンドクラス表記への
 * 組み立てロジックを確定・検証する。
 */

import { RANKS, SUITS, rankIndex, parseHandClass } from '@oshihiki/core';
import type { Gray, Read, Rect } from './types.js';
import { bestMatch, matchConfidence, type Template } from './match.js';
import { resize } from './raster.js';
import { cornerOf } from './detect.js';
import { recognizeSuit, type Rgba } from './color.js';

/** カードコード（例 "Ah", "Td", "2c"）を rank/suit に分解。不正なら null。 */
export function parseCardCode(code: string): { rank: string; suit: string } | null {
  if (code.length !== 2) return null;
  const rank = code[0]!;
  const suit = code[1]!;
  if (rankIndex(rank) < 0) return null;
  if (!(SUITS as readonly string[]).includes(suit)) return null;
  return { rank, suit };
}

/**
 * 2 枚のカードコード → 169 ハンドクラス表記（高ランク先）。不正なら null。
 * 同ランク→ペア、同スート→'s'、異スート→'o'。
 */
export function heroHandFromCards(c1: string, c2: string): string | null {
  const a = parseCardCode(c1);
  const b = parseCardCode(c2);
  if (!a || !b) return null;
  const ia = rankIndex(a.rank);
  const ib = rankIndex(b.rank);
  // 強い（index 小）を hi に
  const [hi, lo, sameSuit] =
    ia <= ib ? [a.rank, b.rank, a.suit === b.suit] : [b.rank, a.rank, a.suit === b.suit];
  let label: string;
  if (hi === lo) {
    // ペア: 同一カード（同ランク同スート）は不正
    if (a.rank === b.rank && a.suit === b.suit) return null;
    label = `${hi}${lo}`;
  } else {
    label = `${hi}${lo}${sameSuit ? 's' : 'o'}`;
  }
  return parseHandClass(label)?.label ?? null;
}

/** 全 52 枚のカードコード一覧（テンプレ生成・検証用）。 */
export function allCardCodes(): string[] {
  const out: string[] = [];
  for (const r of RANKS) for (const s of SUITS) out.push(`${r}${s}`);
  return out;
}

/** 単一カード領域 → カードコード＋信頼度。templates.label はカードコード。 */
export function recognizeCard(region: Gray, templates: readonly Template[]): Read<string> {
  const m = bestMatch(region, templates);
  return { value: m.label, conf: matchConfidence(m) };
}

// --- 色対応のカード認識（確定アーキテクチャ: ランク=NCC, スート=4 色）---
// accuracy 検証（独立キャプチャ 144216, 絵札含む）で rank/suit/フルカードとも 16/16。

/**
 * ランク角のカード幅・高さ比。**glyph バンドを必ず内包するよう広め**に取り（左右席で
 * ランクの位置/スケールが違う＝右札は大きく下寄り）、bandTight でグリフを外接矩形に
 * タイト化してから正規化する（固定率クロップの位置/スケール感受性を除去）。
 */
const RANK_CORNER: [number, number] = [0.6, 0.55];
/** スート色を取る領域（顔絵を避け、左上のランク文字を狭く）。 */
const SUIT_CORNER: [number, number] = [0.42, 0.3];
/** 正規化した角のサイズ（テンプレと揃える）。 */
const CANON_W = 30;
const CANON_H = 38;
/** ランクグリフの二値化しきい値（暗いインク < THR）。 */
const RANK_INK_THR = 140;

function grayCrop(img: Rgba, rect: Rect): Gray {
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(img.w, rect.x + rect.w);
  const y1 = Math.min(img.h, rect.y + rect.h);
  const w = Math.max(0, x1 - x0);
  const h = Math.max(0, y1 - y0);
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = ((y0 + y) * img.w + (x0 + x)) * 4;
      data[y * w + x] = (img.data[s]! * 77 + img.data[s + 1]! * 150 + img.data[s + 2]! * 29) >> 8;
    }
  return { w, h, data };
}

interface InkComp { x0: number; y0: number; x1: number; y1: number; a: number; }
/** 暗インクの連結成分（4 近傍）。 */
function inkComponents(bin: Uint8Array, w: number, h: number): InkComp[] {
  const label = new Int32Array(w * h).fill(-1);
  const boxes: InkComp[] = [];
  const st: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!bin[i] || label[i] !== -1) continue;
    const id = boxes.length;
    boxes.push({ x0: w, y0: h, x1: -1, y1: -1, a: 0 });
    st.length = 0; st.push(i); label[i] = id;
    while (st.length) {
      const p = st.pop()!;
      const px = p % w, py = (p / w) | 0;
      const b = boxes[id]!; b.a++;
      if (px < b.x0) b.x0 = px; if (px > b.x1) b.x1 = px;
      if (py < b.y0) b.y0 = py; if (py > b.y1) b.y1 = py;
      if (px > 0 && bin[p - 1] && label[p - 1] === -1) { label[p - 1] = id; st.push(p - 1); }
      if (px < w - 1 && bin[p + 1] && label[p + 1] === -1) { label[p + 1] = id; st.push(p + 1); }
      if (py > 0 && bin[p - w] && label[p - w] === -1) { label[p - w] = id; st.push(p - w); }
      if (py < h - 1 && bin[p + w] && label[p + w] === -1) { label[p + w] = id; st.push(p + w); }
    }
  }
  return boxes;
}

/**
 * ランク角グレースケール → グリフ外接矩形にタイト化して canonical(30×38)へ。
 * ランクは角の**上段バンド**に横並びで座す（"10" は 2 成分）。suit pip は下段の別バンド。
 * 最上の有意成分でバンドを決め、y が重なる成分だけまとめて bbox を取る → suit pip や
 * 影を除外しつつ多桁ランクを保持。位置/スケール差を吸収し cross-session に強い。
 * 有意成分が無ければ角全体を resize（合成の checkerboard 等のフォールバック）。
 */
export function rankGlyph(img: Rgba, card: Rect): Gray {
  const [rw, rh] = RANK_CORNER;
  const g = grayCrop(img, cornerOf(card, rw, rh));
  const { w, h, data } = g;
  if (w === 0 || h === 0) return resize(g, CANON_W, CANON_H);
  const bin = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) bin[i] = data[i]! < RANK_INK_THR ? 1 : 0;
  const minA = Math.max(8, 0.01 * w * h);
  const comps = inkComponents(bin, w, h).filter(
    (c) => c.a >= minA && c.x1 - c.x0 + 1 < 0.9 * w && c.y1 - c.y0 + 1 < 0.95 * h,
  );
  if (comps.length === 0) return resize(g, CANON_W, CANON_H);
  const top = [...comps].sort((a, b) => a.y0 - b.y0)[0]!;
  const cy = (top.y0 + top.y1) / 2;
  const band = top.y1 - top.y0 + 1;
  const grp = comps.filter((c) => {
    const c2 = (c.y0 + c.y1) / 2;
    return Math.abs(c2 - cy) <= 0.6 * band || (c.y0 <= top.y1 && c.y1 >= top.y0);
  });
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (const c of grp) { if (c.x0 < x0) x0 = c.x0; if (c.y0 < y0) y0 = c.y0; if (c.x1 > x1) x1 = c.x1; if (c.y1 > y1) y1 = c.y1; }
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const cr: Gray = { w: cw, h: ch, data: new Uint8Array(cw * ch) };
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) cr.data[y * cw + x] = data[(y0 + y) * w + (x0 + x)]!;
  return resize(cr, CANON_W, CANON_H);
}

/** 描画ラベル "10" は core の 'T' に対応させる。 */
function normalizeRank(label: string): string {
  return label === '10' ? 'T' : label;
}

/**
 * カード矩形（検出済み or プレイ画面の固定座標）→ カードコード（例 "Jh"）＋信頼度。
 * ランクはグレースケール NCC（rankTemplates の label はランク: "2".."9","10","J","Q","K","A"）、
 * スートは 4 色分類。card は画像内のカード全体の矩形。テンプレも rankGlyph で生成する（単一の真実）。
 */
export function recognizeCardColor(
  img: Rgba,
  card: Rect,
  rankTemplates: readonly Template[],
): Read<string> {
  const m = bestMatch(rankGlyph(img, card), rankTemplates);
  const [sw, sh] = SUIT_CORNER;
  const suit = recognizeSuit(img, cornerOf(card, sw, sh));
  const rank = normalizeRank(m.label);
  return { value: `${rank}${suit.value}`, conf: Math.min(matchConfidence(m), suit.conf) };
}

/**
 * hero の 2 枚（矩形指定）→ ハンドクラス表記＋信頼度。色対応版。
 */
export function recognizeHeroHandColor(
  img: Rgba,
  card1: Rect,
  card2: Rect,
  rankTemplates: readonly Template[],
): Read<string> {
  const c1 = recognizeCardColor(img, card1, rankTemplates);
  const c2 = recognizeCardColor(img, card2, rankTemplates);
  const label = heroHandFromCards(c1.value, c2.value);
  if (label === null) return { value: '', conf: 0 };
  return { value: label, conf: Math.min(c1.conf, c2.conf) };
}

/**
 * hero の 2 枚 → ハンドクラス表記＋信頼度。
 * 組み立てに失敗（不正コード）した場合は conf=0。
 */
export function recognizeHeroHand(
  region1: Gray,
  region2: Gray,
  templates: readonly Template[],
): Read<string> {
  const c1 = recognizeCard(region1, templates);
  const c2 = recognizeCard(region2, templates);
  const label = heroHandFromCards(c1.value, c2.value);
  if (label === null) return { value: '', conf: 0 };
  return { value: label, conf: Math.min(c1.conf, c2.conf) };
}
