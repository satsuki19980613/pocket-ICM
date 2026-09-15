/**
 * オールインの相手に対して自分だけがチップを持っているとき、残りのボードが自動で配られて
 * 精算まで進むこと（さつき実機報告 2026-09-15「オールインが自動で進まない」の回帰）。
 */
import { describe, expect, it } from 'vitest';

import { engine } from '../engine';
import type { ActionKind, TableState } from '../types';
import { currentActorUserId, defaultConfig, makeRng, startTable } from './testKit';

function act(state: TableState, now: number, rng: ReturnType<typeof makeRng>, kind: ActionKind, betTo?: number): TableState {
  const h = state.hand!;
  const r = engine.apply(
    state,
    { t: 'act', userId: currentActorUserId(state), handNo: h.handNo, actSeq: h.actSeq, kind, betTo },
    now,
    rng,
  );
  if (!r.ok) throw new Error(`${kind} rejected: ${r.error}`);
  return r.state;
}

describe('オールイン後の自動進行', () => {
  it('短いスタックのオールインを大きいスタックがコールしたら、残りのボードが配られて精算まで進む', () => {
    const { state: s0, rng } = startTable(defaultConfig({ players: 2, startBb: 75 }), 3);
    // 1 ハンド目でスタック差を作る（SB オールイン → BB フォールド）
    let s = act(s0, 1000, rng, 'allin');
    s = act(s, 1100, rng, 'fold');
    const w = engine.apply(s, { t: 'wake' }, s.wake!.at, rng);
    if (!w.ok) throw new Error(w.error);
    s = w.state;
    expect(s.hand!.handNo).toBe(2);
    const short = s.players.findIndex((p) => p.stack < 15000);
    expect(short).toBeGreaterThanOrEqual(0);

    // 2 ハンド目: 手番の人がオールイン → 相手がコール
    s = act(s, 2000, rng, 'allin');
    s = act(s, 2100, rng, 'call');
    const h = s.hand!;
    expect(h.phase).toBe('settled');
    expect(h.board).toHaveLength(5);
    expect(h.toAct).toBe(-1);
    expect(h.won).not.toBeNull();
    // チップ保存
    const total = s.players.reduce((a, p) => a + p.stack, 0);
    expect(total).toBe(2 * 15000);
  });

  it('3 人で 2 人がオールイン・1 人だけチップが残っていても、コール後は自動で進む', () => {
    const { state: s0, rng } = startTable(defaultConfig({ players: 3, startBb: 75 }), 11);
    // 1 ハンド目: 1 人目オールイン、2 人目フォールド、3 人目フォールド → 差は付かない。
    // 代わりに 2 人がオールインし、3 人目（同額）がコール → 全員オールインで自動進行（既存挙動）。
    let s = act(s0, 1000, rng, 'allin');
    s = act(s, 1100, rng, 'allin');
    s = act(s, 1200, rng, 'call');
    expect(s.hand!.phase).toBe('settled');
    expect(s.hand!.board).toHaveLength(5);
  });

  it('自分だけが actionable でも、まだコールしていなければ手番は回る（機会を奪わない）', () => {
    const { state: s0, rng } = startTable(defaultConfig({ players: 2, startBb: 75 }), 5);
    const s = act(s0, 1000, rng, 'allin');
    expect(s.hand!.phase).toBe('betting');
    expect(s.hand!.toAct).not.toBe(-1);
  });
});
