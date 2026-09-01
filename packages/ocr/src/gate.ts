/**
 * ストリート gate（SPEC §6.3 #8 / Plan 2-2）。
 *
 * プリフロップ以外の画面を確実に弾く。認識した左上のストリート表示ラベルを
 * 正規化し、preflop 以外なら対象外エラーを返す。表記ゆれ（日本語/英語/全角）に
 * 頑健にする。画像非依存の純ロジック。
 */

import type { Read } from './types.js';

export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'unknown';

/** ラベル文字列を正規化してストリートに分類する。 */
export function classifyStreet(label: string): Street {
  const s = label
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s・.／/]/g, '');
  if (!s) return 'unknown';
  // プリフロップ
  if (/(preflop|pre-flop|プリフロップ|プリフロ)/.test(s)) return 'preflop';
  // 誤読耐性: "flop" は preflop の部分文字列なので、preflop 判定を先に行う
  if (/(flop|フロップ)/.test(s)) return 'flop';
  if (/(turn|ターン)/.test(s)) return 'turn';
  if (/(river|リバー)/.test(s)) return 'river';
  return 'unknown';
}

export interface GateResult {
  readonly ok: boolean;
  readonly street: Street;
  readonly issues: string[];
}

/**
 * ストリート gate。preflop のみ通過。
 * unknown（読めない）は「別の写真を選ぶ / 手入力」に誘導するため通さない。
 */
export function streetGate(read: Read<string>): GateResult {
  const street = classifyStreet(read.value);
  if (street === 'preflop') return { ok: true, street, issues: [] };
  if (street === 'unknown') {
    return { ok: false, street, issues: ['ストリート表示が読めませんでした（プリフロップか確認してください）'] };
  }
  return {
    ok: false,
    street,
    issues: [`プリフロップの画面ではありません（検出: ${street}）。押し引きはプリフロップのみ対象です`],
  };
}
