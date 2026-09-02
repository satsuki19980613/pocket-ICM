/**
 * ストリート検出（ボードのコミュニティカード枚数から）。SPEC §6.3 #8。
 *
 * 左上の日本語ラベル（プリフロップ/フロップ…）を文字認識する代わりに、中央ボードの
 * 白いカード枚数を数える方が頑健（4 色デッキで札は白, findCardRects 再利用, 実画像
 * preflop=0 / turn=4 / showdown=5 で確認）。0 枚＝プリフロップ。
 *
 * gate.ts の classifyStreet が受け付ける文字列（'preflop'|'flop'|'turn'|'river'）を返すので、
 * そのまま streetGate に渡せる。
 */

import type { Read, Rect } from './types.js';
import type { Rgba } from './color.js';
import { grayFromRgba } from './numberField.js';
import { findCardRects, type FindCardOptions } from './detect.js';

/** 中央ボード領域の白いカード枚数。 */
export function countBoardCards(img: Rgba, boardRect: Rect, opts: FindCardOptions = {}): number {
  const g = grayFromRgba(img, boardRect);
  return findCardRects(g, { threshold: 190, minAreaFrac: 0.01, closeRadius: 1, ...opts }).length;
}

const BY_COUNT: Record<number, string> = { 0: 'preflop', 3: 'flop', 4: 'turn', 5: 'river' };

/**
 * ボード枚数 → ストリート `Read<string>`。枚数が {0,3,4,5} 以外（1,2 や 6+＝配布アニメ/
 * 誤検出）なら 'unknown' を低信頼で返す。value は classifyStreet が解釈できる英語トークン。
 */
export function readStreetFromBoard(img: Rgba, boardRect: Rect, opts: FindCardOptions = {}): Read<string> {
  const n = countBoardCards(img, boardRect, opts);
  const street = BY_COUNT[n];
  if (street === undefined) return { value: 'unknown', conf: 0.3 };
  return { value: street, conf: 0.95 };
}
