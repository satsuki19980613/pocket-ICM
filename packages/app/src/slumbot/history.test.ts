import { describe, expect, it } from 'vitest';

import type { HandView } from './hand';
import { HAND_ID_RE, buildRecord, isHandRecord, newHandId, preflopFacts, walkActions } from './history';
import { legalActions, parseAction } from './rules';

function viewOf(action: string, heroSeat: number, extra: Partial<HandView> = {}): HandView {
  const p = parseAction(action);
  if (!p.ok) throw new Error(p.error);
  return {
    action,
    heroSeat,
    botSeat: heroSeat === 1 ? 0 : 1,
    holeCards: ['As', 'Kd'],
    botCards: ['Qh', 'Qc'],
    board: ['2s', '7h', 'Tc', '4d', '9c'],
    state: p.state,
    legal: legalActions({ ...p.state, toAct: -1 }),
    over: true,
    heroToAct: false,
    pot: 0,
    stacks: [0, 0],
    winnings: -300,
    ...extra,
  };
}

describe('walkActions', () => {
  it('SB のレイズ → コール → フロップのベット/コール → ターンのチェック → リバーで降り', () => {
    const w = walkActions('b200c/kb100c/kk/b300f');
    expect(w).not.toBeNull();
    const s = w!.steps.map((x) => [x.seat, x.street, x.kind, x.betTo, x.put, x.allIn]);
    expect(s).toEqual([
      [1, 0, 'raise', 200, 150, false],
      [0, 0, 'call', 200, 100, false],
      [0, 1, 'check', 0, 0, false],
      [1, 1, 'bet', 100, 100, false],
      [0, 1, 'call', 100, 100, false],
      [0, 2, 'check', 0, 0, false],
      [1, 2, 'check', 0, 0, false],
      [0, 3, 'bet', 300, 300, false],
      [1, 3, 'fold', 0, 0, false],
    ]);
    expect(w!.allInStreet).toBeNull();
    expect(w!.final.folded).toBe(true);
    expect(w!.final.folder).toBe(1);
  });

  it('プリフロップの捲り合い（SB オールイン → BB コール）', () => {
    const w = walkActions('b20000c');
    expect(w!.steps.map((x) => [x.kind, x.allIn])).toEqual([
      ['raise', true],
      ['call', true],
    ]);
    expect(w!.allInStreet).toBe(0);
    expect(w!.final.allIn).toBe(true);
  });

  it('フロップの捲り合いはフロップを覚える', () => {
    const w = walkActions('b200c/b19800c');
    expect(w!.allInStreet).toBe(1);
  });

  it('リバーのオールインは捲り合いではない（EV は実収支）', () => {
    const w = walkActions('ck/kk/kk/b19900c');
    expect(w!.steps.at(-1)!.allIn).toBe(true);
    expect(w!.allInStreet).toBeNull();
    expect(w!.final.allIn).toBe(true);
  });

  it('コールの put はコール額（自分の出した分を引く）', () => {
    const w = walkActions('b600c');
    expect(w!.steps[1]).toMatchObject({ seat: 0, kind: 'call', betTo: 600, put: 500 });
  });

  it('壊れた文字列は null', () => {
    expect(walkActions('kk')).toBeNull();
    expect(walkActions('b20000cf')).toBeNull();
    expect(walkActions('x')).toBeNull();
  });
});

describe('preflopFacts', () => {
  it('SB で自分がオープン: VPIP/PFR、3Bet の機会なし', () => {
    const f = preflopFacts(walkActions('b200c/kk/kk/kk')!.steps, 1);
    expect(f).toEqual({ vpipOpp: true, vpip: true, pfr: true, threeBetOpp: false, threeBet: false });
  });

  it('BB で相手のオープンにコール: VPIP のみ、3Bet の機会あり', () => {
    const f = preflopFacts(walkActions('b200c/kk/kk/kk')!.steps, 0);
    expect(f).toEqual({ vpipOpp: true, vpip: true, pfr: false, threeBetOpp: true, threeBet: false });
  });

  it('BB で 3Bet', () => {
    const f = preflopFacts(walkActions('b200b600f')!.steps, 0);
    expect(f.threeBetOpp).toBe(true);
    expect(f.threeBet).toBe(true);
    expect(f.pfr).toBe(true);
  });

  it('SB で 4Bet は 3Bet に数えない', () => {
    const f = preflopFacts(walkActions('b200b600b1800f')!.steps, 1);
    expect(f.threeBetOpp).toBe(false);
    expect(f.threeBet).toBe(false);
  });

  it('BB で相手が先に降りた walk は機会なし', () => {
    const f = preflopFacts(walkActions('f')!.steps, 0);
    expect(f.vpipOpp).toBe(false);
    expect(f.vpip).toBe(false);
  });

  it('BB のチェックは VPIP ではない', () => {
    const f = preflopFacts(walkActions('ck/kk/kk/kk')!.steps, 0);
    expect(f.vpipOpp).toBe(true);
    expect(f.vpip).toBe(false);
  });
});

describe('newHandId', () => {
  it('sb_ 始まりで CHECK 制約の形に合う', () => {
    const id = newHandId(1_757_900_000_000, () => 0.5);
    expect(id).toMatch(HAND_ID_RE);
    expect(id.startsWith('sb_')).toBe(true);
  });
});

describe('buildRecord', () => {
  it('降りて終わったハンド: ボードを到達ストリートまでに切り詰め、相手の手札は持たない', () => {
    const rec = buildRecord(viewOf('b200c/kb100f', 1), 1000, 'sb_abc123')!;
    expect(rec.board).toEqual(['2s', '7h', 'Tc']);
    expect(rec.botCards).toBeNull();
    expect(rec.showdown).toBe(false);
    expect(rec.evWinnings).toBe(-300);
    expect(rec.synced).toBe(false);
    expect(isHandRecord(rec)).toBe(true);
  });

  it('プリフロップで降りたらボードは空', () => {
    const rec = buildRecord(viewOf('f', 0, { winnings: 50 }), 1000, 'sb_abc123')!;
    expect(rec.board).toEqual([]);
  });

  it('捲り合いは EV を未計算（null）にしておく', () => {
    const rec = buildRecord(viewOf('b20000c', 1, { winnings: 20000 }), 1000, 'sb_abc123')!;
    expect(rec.board).toHaveLength(5);
    expect(rec.botCards).toEqual(['Qh', 'Qc']);
    expect(rec.evWinnings).toBeNull();
    expect(rec.showdown).toBe(true);
  });

  it('終わっていなければ null', () => {
    expect(buildRecord(viewOf('b200', 1, { over: false }), 1000, 'sb_abc123')).toBeNull();
  });
});

describe('isHandRecord', () => {
  it('形の崩れた記録を弾く', () => {
    const good = buildRecord(viewOf('f', 0, { winnings: 50 }), 1000, 'sb_abc123')!;
    expect(isHandRecord({ ...good, id: 'easzNx' })).toBe(false);
    expect(isHandRecord({ ...good, heroCards: ['As'] })).toBe(false);
    expect(isHandRecord({ ...good, winnings: 'x' })).toBe(false);
    expect(isHandRecord(null)).toBe(false);
  });
});
