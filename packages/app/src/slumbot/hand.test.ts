import { describe, expect, it } from 'vitest';

import type { SlumbotResponse } from './api';
import { describeLastAction, toView } from './hand';

/** 調査セッションで実際に Slumbot から返ってきた JSON をそのまま使う。 */
const NEW_HAND: SlumbotResponse = {
  old_action: '',
  action: 'b200',
  client_pos: 0,
  hole_cards: ['As', '7s'],
  board: [],
  token: '2a46e747-0934-4955-beaa-f101e01c3dd4',
};

const FLOP: SlumbotResponse = {
  old_action: 'b200',
  action: 'b200c/',
  client_pos: 0,
  hole_cards: ['As', '7s'],
  board: ['8h', '6d', '2s'],
};

const SHOWDOWN: SlumbotResponse = {
  old_action: 'b200c/kk/kb200c/',
  action: 'b200c/kk/kb200c/kk',
  client_pos: 0,
  hole_cards: ['Ad', '9s'],
  board: ['Kc', '4c', '3s', '2s', '2d'],
  bot_hole_cards: ['As', 'Ts'],
  winnings: -400,
  won_pot: -800,
  session_num_hands: 1,
  session_total: -400,
};

const FOLDED: SlumbotResponse = {
  old_action: 'b200',
  action: 'b200f',
  client_pos: 0,
  hole_cards: ['7d', '2c'],
  board: [],
  bot_hole_cards: ['9d', '5d'],
  winnings: -100,
  won_pot: -300,
};

function view(res: SlumbotResponse) {
  const r = toView(res);
  if (!r.ok) throw new Error(r.error);
  return r.view;
}

describe('toView', () => {
  it('新ハンド: 相手のオープンレイズを受けた自分（BB）の手番', () => {
    const v = view(NEW_HAND);
    expect(v.heroSeat).toBe(0);
    expect(v.botSeat).toBe(1);
    expect(v.heroToAct).toBe(true);
    expect(v.over).toBe(false);
    expect(v.pot).toBe(300);
    expect(v.stacks).toEqual([19900, 19800]);
    expect(v.legal.canCall).toBe(true);
    expect(v.legal.callAmount).toBe(100);
    expect(v.legal.canCheck).toBe(false);
    expect(v.legal.isRaise).toBe(true); // プリフロップは常に「RAISE」表記
    expect(v.board).toEqual([]);
  });

  it('フロップ: ボードが 3 枚になり、自分（BB）が先手でチェックできる', () => {
    const v = view(FLOP);
    expect(v.state.street).toBe(1);
    expect(v.board).toEqual(['8h', '6d', '2s']);
    expect(v.heroToAct).toBe(true);
    expect(v.legal.canCheck).toBe(true);
    expect(v.legal.canFold).toBe(false);
    expect(v.legal.isRaise).toBe(false); // ポストフロップの無風は「BET」表記
    expect(v.pot).toBe(400);
  });

  it('ショーダウン: 終了扱いになり、相手の手札と収支が入る', () => {
    const v = view(SHOWDOWN);
    expect(v.over).toBe(true);
    expect(v.heroToAct).toBe(false);
    expect(v.botCards).toEqual(['As', 'Ts']);
    expect(v.winnings).toBe(-400);
    expect(v.board).toHaveLength(5);
    expect(v.legal.canCheck).toBe(false);
    expect(v.legal.canBet).toBe(false);
  });

  it('フォールド決着でも終了扱いになる', () => {
    const v = view(FOLDED);
    expect(v.over).toBe(true);
    expect(v.state.folded).toBe(true);
    expect(v.state.folder).toBe(0); // 降りたのは自分（BB）
    expect(v.winnings).toBe(-100);
  });

  it('オールインに降りられたハンドも終了扱いで、ポットが正しい', () => {
    const v = view({
      action: 'b20000f',
      client_pos: 1,
      hole_cards: ['Ah', 'Ad'],
      board: [],
      bot_hole_cards: ['7c', '2d'],
      winnings: 100,
    });
    expect(v.over).toBe(true);
    expect(v.heroSeat).toBe(1);
    expect(v.state.folded).toBe(true);
    expect(v.pot).toBe(20100);
    expect(v.winnings).toBe(100);
  });

  it('ポストフロップで降りたハンドも終了扱いになる', () => {
    const v = view({
      action: 'b200c/b400f',
      client_pos: 1,
      hole_cards: ['Jh', '8c'],
      board: ['2c', '7d', 'Ks'],
      bot_hole_cards: ['Ac', 'Qd'],
      winnings: -200,
    });
    expect(v.over).toBe(true);
    expect(v.state.street).toBe(1);
    expect(v.board).toHaveLength(3);
    expect(v.heroToAct).toBe(false);
  });

  it('壊れたアクション列は失敗として返す（画面が固まらないように）', () => {
    expect(toView({ action: 'zzz' }).ok).toBe(false);
  });
});

describe('describeLastAction', () => {
  it('プリフロップの `b` はオープンでもレイズ表記', () => {
    expect(describeLastAction('b200')).toEqual({
      seat: 1,
      kind: 'raise',
      betTo: 200,
      label: 'RAISE 2bb',
    });
  });

  it('ポストフロップの初手ベットはベット表記', () => {
    const a = describeLastAction('b200c/b300');
    expect(a?.seat).toBe(0);
    expect(a?.kind).toBe('bet');
    expect(a?.label).toBe('BET 3bb');
  });

  it('ベットへの再ベットはレイズ表記', () => {
    const a = describeLastAction('b200c/b300b900');
    expect(a?.seat).toBe(1);
    expect(a?.kind).toBe('raise');
    expect(a?.label).toBe('RAISE 9bb');
  });

  it('スタックいっぱいのベットは ALL IN 表記', () => {
    expect(describeLastAction('b20000')?.label).toBe('ALL IN 200bb');
  });

  it('チェック・コール・フォールド', () => {
    expect(describeLastAction('b200c/k')).toEqual({ seat: 0, kind: 'check', betTo: 0, label: 'CHECK' });
    expect(describeLastAction('b200c')?.label).toBe('CALL 1bb');
    expect(describeLastAction('b200f')).toEqual({ seat: 0, kind: 'fold', betTo: 0, label: 'FOLD' });
  });

  it('末尾のストリート区切りは無視して直前の手を読む', () => {
    expect(describeLastAction('b200c/')?.label).toBe('CALL 1bb');
    expect(describeLastAction('b200c/kk/')?.label).toBe('CHECK');
  });

  it('コールでオールインになっても表記は CALL のまま（額で分かるため）', () => {
    const a = describeLastAction('b200c/b19800c');
    expect(a?.kind).toBe('call');
    expect(a?.label).toBe('CALL 198bb');
  });

  it('アクションが 1 つも無ければ null', () => {
    expect(describeLastAction('')).toBeNull();
  });
});
