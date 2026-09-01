/**
 * カード認識（52 種テンプレートマッチ＋ハンドクラス組み立て）。SPEC §6.3 #1。
 *
 * カード表面デザインは全プレイヤー・全装飾品で統一（§5.1 確認済み）なので、
 * 52 枚のテンプレへの NCC マッチで足りる。テンプレは利用者スクショから初回生成
 * （§10 / R-10、リポジトリに含めない）。ここでは 2 枚 → ハンドクラス表記への
 * 組み立てロジックを確定・検証する。
 */

import { RANKS, SUITS, rankIndex, parseHandClass } from '@oshihiki/core';
import type { Gray, Read } from './types.js';
import { bestMatch, matchConfidence, type Template } from './match.js';

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
