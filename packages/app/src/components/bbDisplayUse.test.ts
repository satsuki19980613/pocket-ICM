import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatBbDisplay } from '@oshihiki/core';

/**
 * bb 換算の値は**ゲームと同じ丸め**（小数第 2 位を四捨五入・`formatBbDisplay`）で出す
 * （さつき指示 2026-09-12）。スタック/ベットの表示がこのヘルパを通さず生の値を出していると、
 * 画面には 42.15bb のようにゲームには存在しない桁が出て、実機と突き合わせられなくなる。
 * 表示箇所が増えたときに素通りしないよう、ソースを機械的に見張る。
 */
// パスに日本語が入るので import.meta.url の pathname は使えない（パーセントエンコードされる）。
const HERE = dirname(fileURLToPath(import.meta.url));

describe('bb 表示はゲームと同じ丸めを通す', () => {
  it('丸めの仕様（実測で確定した挙動）', () => {
    expect(formatBbDisplay(42.15)).toBe('42.2'); // x.x5 は切り上げ（四捨五入）
    expect(formatBbDisplay(29.25)).toBe('29.3');
    expect(formatBbDisplay(2.75)).toBe('2.8');
    expect(formatBbDisplay(3)).toBe('3'); // 末尾の .0 は出さない
    expect(formatBbDisplay(1.2 + 0.15)).toBe('1.4'); // 浮動小数の誤差に負けない
  });

  it.each(['Confirm.tsx', 'Result.tsx', 'PokerTable.tsx', 'ActionTree.tsx'])(
    '%s は bb をそのまま描画しない',
    (file) => {
      const src = readFileSync(join(HERE, file), 'utf8');
      // `{s.stack}bb` のような「生の値 + bb」を禁止する（formatBbDisplay(...) を通っていれば括弧で終わる）。
      const raw = src.match(/\{[^{}]*\.(stack|bet)[^{}]*\}bb/g) ?? [];
      const offenders = raw.filter((m) => !m.includes('formatBbDisplay'));
      expect(offenders).toEqual([]);
    },
  );
});
