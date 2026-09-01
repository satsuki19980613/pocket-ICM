/**
 * 解の正規キー（IMPLEMENTATION_PLAN §3.2）。
 *
 * 「残存ポジションを行動順に全列挙し、未行動を `-` で埋める」形式で一意化する。
 * 例: "UTG:P,CO:F,BU:-,SB:-,BB:-"
 *
 * アクション文字:
 *   '-' 未行動 / 'P' プッシュ(オールイン) / 'C' コール / 'F' フォールド
 */

import { positionsForPlayersLeft, type Position } from './positions.js';

export const ACTION_CHARS = ['-', 'P', 'C', 'F'] as const;
export type ActionChar = (typeof ACTION_CHARS)[number];

export type ActionMap = Partial<Record<Position, ActionChar>>;

export interface ParsedKeyEntry {
  pos: Position;
  action: ActionChar;
}

export interface ParsedKey {
  playersLeft: number;
  entries: ParsedKeyEntry[];
}

function isActionChar(c: string): c is ActionChar {
  return (ACTION_CHARS as readonly string[]).includes(c);
}

/**
 * 残り人数と各ポジションのアクションから正規キーを生成する。
 * 指定のないポジションは未行動 '-'。行動順に並ぶ。
 */
export function normalizeKey(playersLeft: number, actions: ActionMap = {}): string {
  const order = positionsForPlayersLeft(playersLeft);
  return order
    .map((pos) => {
      const a = actions[pos] ?? '-';
      if (!isActionChar(a)) {
        throw new Error(`invalid action char for ${pos}: ${String(a)}`);
      }
      return `${pos}:${a}`;
    })
    .join(',');
}

/**
 * 正規キーをパースする。行動順・ポジション集合が残り人数の正規形と
 * 一致しない場合は例外を投げる（正規形の一意性を保証）。
 */
export function parseKey(key: string): ParsedKey {
  const parts = key.split(',');
  const entries: ParsedKeyEntry[] = parts.map((part) => {
    const [pos, action] = part.split(':');
    if (pos === undefined || action === undefined) {
      throw new Error(`malformed key segment: "${part}"`);
    }
    if (!isActionChar(action)) {
      throw new Error(`invalid action char in key: "${part}"`);
    }
    return { pos: pos as Position, action };
  });

  const playersLeft = entries.length;
  const expected = positionsForPlayersLeft(playersLeft);
  const gotOrder = entries.map((e) => e.pos).join(',');
  const expOrder = expected.join(',');
  if (gotOrder !== expOrder) {
    throw new Error(
      `key not in canonical action order for ${playersLeft} players: got [${gotOrder}], expected [${expOrder}]`,
    );
  }
  return { playersLeft, entries };
}

/** parseKey → normalizeKey が入力キーに一致するか（正規形判定）。 */
export function isCanonicalKey(key: string): boolean {
  try {
    const parsed = parseKey(key);
    const actions: ActionMap = {};
    for (const e of parsed.entries) actions[e.pos] = e.action;
    return normalizeKey(parsed.playersLeft, actions) === key;
  } catch {
    return false;
  }
}
