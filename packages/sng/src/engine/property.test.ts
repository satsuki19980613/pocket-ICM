/**
 * 性質テスト: ランダムなアクション列を 200 ハンド流し、常に
 *   - Σwon === Σcommits（チップ保存）
 *   - won は全て非負整数
 *   - 卓の総チップ（players の stack 合計 + 進行中ハンドの外側は不変）
 * が成り立つことを確認する。
 */

import { describe, expect, it } from 'vitest';

import { engine } from '../engine';
import type { TableState } from '../types';
import { computeLegalActions } from './betting';
import { defaultConfig, makeRng, startTable } from './testKit';

/**
 * players[].stack はハンド中も精算まで変えない（`docs/SNG_DESIGN.md` の設計どおり）ので、
 * 「まだ手元にある額」＋「ポットに入れた額」の合計は常に players[].stack そのもの。
 * ハンドが進んでいる間に増減しないことが Σwon=Σcommits の一番強い検証になる。
 */
function totalChips(state: TableState): number {
  let total = 0;
  for (const p of state.players) total += p.stack;
  return total;
}

describe('チップ保存則（性質テスト・200ハンド）', () => {
  it('Σwon=Σcommits・won は非負整数・卓の総チップが不変', () => {
    const players = 6;
    const config = defaultConfig({ players: players as 6, startBb: 40 });
    const { state: initial, rng } = startTable(config, 999);
    const expectedTotal = totalChips(initial);

    let state = initial;
    let now = 0;
    let handsSettled = 0;
    let steps = 0;
    const maxSteps = 20000;

    while (handsSettled < 200 && steps < maxSteps) {
      steps++;
      if (state.status === 'finished' || state.status === 'cancelled') break;
      if (!state.hand || state.hand.toAct === -1) {
        // 手番が無い（ハンド間 or ポーズ）→ wake を進める。
        now = state.wake ? state.wake.at : now + 1;
        const r = engine.apply(state, { t: 'wake' }, now, rng);
        if (!r.ok) throw new Error(r.error);
        state = r.state;
        for (const e of r.effects) {
          if (e.t === 'hand_finished') {
            handsSettled++;
            for (const w of e.record.won) {
              expect(Number.isInteger(w)).toBe(true);
              expect(w).toBeGreaterThanOrEqual(0);
            }
          }
        }
        // 卓の総チップ（players.stack 合計 + 進行中ハンドの commits 合計）は常に不変
        // ＝どのハンドの精算でも Σwon===Σcommits でなければ崩れる。
        expect(totalChips(state)).toBe(expectedTotal);
        continue;
      }

      const hand = state.hand;
      const seat = hand.toAct;
      const stack = hand.startStacks[seat]! - hand.commits[seat]!;
      const legal = computeLegalActions(hand, seat, stack);
      const userId = state.players.find((p) => p.seat === seat)!.userId;

      // 乱択で行動を決める（fold 30% / check-call 50% / bet-raise-allin 20%）。
      const roll = rng();
      let kind: 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin';
      let betTo: number | undefined;
      if (roll < 0.3 && legal.canFold) {
        kind = 'fold';
      } else if (legal.canCheck) {
        kind = 'check';
      } else if (legal.callPut !== null) {
        kind = roll > 0.85 && legal.betTo !== null ? (legal.aggression === 'bet' ? 'bet' : 'raise') : 'call';
        if (kind !== 'call') betTo = legal.betTo!.min;
      } else if (legal.canFold) {
        kind = 'fold';
      } else {
        kind = 'check';
      }
      if ((kind === 'bet' || kind === 'raise') && legal.betTo === null) kind = 'call';

      const r = engine.apply(state, { t: 'act', userId, handNo: hand.handNo, actSeq: hand.actSeq, kind, betTo }, now, rng);
      if (!r.ok) throw new Error(`act failed: ${r.error} kind=${kind}`);
      state = r.state;
      for (const e of r.effects) {
        if (e.t === 'hand_finished') {
          handsSettled++;
          const total = e.record.won.reduce((a, b) => a + b, 0);
          for (const w of e.record.won) {
            expect(Number.isInteger(w)).toBe(true);
            expect(w).toBeGreaterThanOrEqual(0);
          }
          expect(total).toBeGreaterThanOrEqual(0);
        }
      }
      expect(totalChips(state)).toBe(expectedTotal);
    }

    expect(handsSettled).toBeGreaterThan(0);
  });
});
