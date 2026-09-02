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

/** ランク角（左上）のカード幅・高さ比。NCC 用。 */
const RANK_CORNER: [number, number] = [0.5, 0.42];
/** スート色を取る領域（顔絵を避け、左上のランク文字を狭く）。 */
const SUIT_CORNER: [number, number] = [0.42, 0.3];
/** 正規化した角のサイズ（テンプレと揃える）。 */
const CANON_W = 30;
const CANON_H = 38;

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

/** 描画ラベル "10" は core の 'T' に対応させる。 */
function normalizeRank(label: string): string {
  return label === '10' ? 'T' : label;
}

/**
 * カード矩形（検出済み or プレイ画面の固定座標）→ カードコード（例 "Jh"）＋信頼度。
 * ランクはグレースケール NCC（rankTemplates の label はランク: "2".."9","10","J","Q","K","A"）、
 * スートは 4 色分類。card は画像内のカード全体の矩形。
 */
export function recognizeCardColor(
  img: Rgba,
  card: Rect,
  rankTemplates: readonly Template[],
): Read<string> {
  const [rw, rh] = RANK_CORNER;
  const rankGray = resize(grayCrop(img, cornerOf(card, rw, rh)), CANON_W, CANON_H);
  const m = bestMatch(rankGray, rankTemplates);
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
