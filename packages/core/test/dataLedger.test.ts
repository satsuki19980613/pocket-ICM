import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAME_MODES, GAME_MODE_SPECS, totalChipsOf, type GameMode } from '../src/index.js';

/**
 * `docs/DATA_LEDGER.md`（データ管理台帳）とコードの数値が食い違ったら落とすテスト。
 *
 * 台帳の約束は「数値の正本はコード、台帳は一覧と由来」。一覧が古びると台帳を信じた判断が
 * 狂うので、機械的に突き合わせる。数値を変えるときは**コードと台帳の両方**を直すこと。
 * パスに日本語が入るので import.meta.url の pathname は使わない（パーセントエンコードされる）。
 */
const LEDGER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'docs', 'DATA_LEDGER.md');

interface Row {
  id: string;
  payouts: number[];
  stack: number;
  players: number;
  total: number;
}

function parseLedger(): Row[] {
  const md = readFileSync(LEDGER, 'utf8');
  const rows: Row[] = [];
  for (const line of md.split(/\r?\n/)) {
    // | `club` | クラブマッチ | — | 5 / 3 / 2 / 1 / 0 / -1 | 15000 | 6 | 90000 |
    const m = /^\|\s*`([a-z0-9-]+)`\s*\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|/.exec(line);
    if (!m) continue;
    rows.push({
      id: m[1]!,
      payouts: m[4]!.split('/').map((x) => Number(x.trim())),
      stack: Number(m[5]!.trim()),
      players: Number(m[6]!.trim()),
      total: Number(m[7]!.trim()),
    });
  }
  return rows;
}

describe('データ管理台帳とコードの同期', () => {
  const rows = parseLedger();

  it('台帳のモード表が読めている（書式が壊れていない）', () => {
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.payouts).toHaveLength(6);
      expect(r.payouts.every(Number.isFinite)).toBe(true);
      expect(Number.isFinite(r.stack)).toBe(true);
    }
  });

  it('台帳に載っているモードとコードのモードが過不足なく一致する', () => {
    expect(rows.map((r) => r.id).sort()).toEqual([...GAME_MODES].sort());
  });

  it.each(GAME_MODES)('%s の数値が台帳と一致する', (mode: GameMode) => {
    const row = rows.find((r) => r.id === mode);
    expect(row, `台帳に ${mode} の行がない`).toBeDefined();
    const spec = GAME_MODE_SPECS[mode];
    expect(row!.payouts).toEqual([...spec.payouts]);
    expect(row!.stack).toBe(spec.startingStack);
    expect(row!.players).toBe(spec.startingPlayers);
    expect(row!.total).toBe(totalChipsOf(mode));
  });

  it('台帳が主張する「総チップ = 開始スタック × 人数」が実際に成り立つ', () => {
    for (const r of rows) expect(r.stack * r.players).toBe(r.total);
  });
});
