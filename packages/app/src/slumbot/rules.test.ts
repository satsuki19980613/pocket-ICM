import { describe, expect, it } from 'vitest';

import {
  BB,
  STACK,
  committed,
  legalActions,
  parseAction,
  potOf,
  signedBbLabel,
  stackOf,
  bbLabel,
  toCallOf,
  type HandState,
} from './rules';

/** テストを読みやすくするための取り出しヘルパ（失敗したらその場で落とす）。 */
function st(action: string): HandState {
  const r = parseAction(action);
  if (!r.ok) throw new Error(`parse failed: ${action} -> ${r.error}`);
  return r.state;
}

function errOf(action: string): string {
  const r = parseAction(action);
  if (r.ok) throw new Error(`expected failure: ${action}`);
  return r.error;
}

describe('parseAction: プリフロップの初期状態', () => {
  it('空文字は SB/BTN（席1）の手番で、BB=100 に 50 不足している', () => {
    const s = st('');
    expect(s.street).toBe(0);
    expect(s.toAct).toBe(1);
    expect(s.streetBet).toEqual([100, 50]);
    expect(potOf(s)).toBe(150);
    expect(toCallOf(s)).toBe(50);
  });

  it('SB はチェックできない（本家の Illegal check と同じ）', () => {
    expect(errOf('k')).toBe('チェックできない場面です');
  });

  it('SB の最小レイズは 200 まで（＝2bb）。199 以下は弾く', () => {
    const a = legalActions(st(''));
    expect(a.minBetTo).toBe(200);
    expect(a.maxBetTo).toBe(STACK);
    expect(errOf('b199')).toBe('ベットが小さすぎます');
    expect(errOf('b20001')).toBe('ベットが大きすぎます');
    expect(parseAction('b200').ok).toBe(true);
    expect(parseAction('b20000').ok).toBe(true);
  });

  it('SB のリンプ（コール）で BB に手番が渡り、BB はチェックできる', () => {
    const s = st('b200');
    expect(s.toAct).toBe(0);
    const a = legalActions(s);
    expect(a.canCheck).toBe(false);
    expect(a.canCall).toBe(true);
    expect(a.callAmount).toBe(100);
    expect(a.canFold).toBe(true);
    expect(a.isRaise).toBe(true);
    // ミニレイズ幅は直前の上乗せ 100 → 300 まで。
    expect(a.minBetTo).toBe(300);
  });
});

describe('parseAction: ストリートの切り替わり', () => {
  it('プリフロップのコール成立でフロップへ移り、先手は BB（席0）', () => {
    const s = st('b200c/');
    expect(s.street).toBe(1);
    expect(s.toAct).toBe(0);
    expect(s.streetBet).toEqual([0, 0]);
    expect(s.carry).toEqual([200, 200]);
    expect(potOf(s)).toBe(400);
    expect(stackOf(s, 0)).toBe(STACK - 200);
    const a = legalActions(s);
    expect(a.canCheck).toBe(true);
    expect(a.canFold).toBe(false); // 誰も張っていない場面で降りる操作は無い。
    expect(a.minBetTo).toBe(BB);
    expect(a.maxBetTo).toBe(STACK - 200);
  });

  it('末尾の `/` は有っても無くても同じ状態になる', () => {
    expect(st('b200c/')).toEqual(st('b200c'));
    expect(st('b200c/kk/')).toEqual(st('b200c/kk'));
  });

  it('チェック回しでもストリートが進む', () => {
    const s = st('b200c/kk/');
    expect(s.street).toBe(2);
    expect(potOf(s)).toBe(400);
    expect(s.toAct).toBe(0);
  });

  it('ポストフロップのレイズ上限は「前ストリートまでの拠出」を引いた残り', () => {
    const a = legalActions(st('b200c/'));
    expect(a.maxBetTo).toBe(19800);
    const s = st('b200c/b500');
    const b = legalActions(s);
    expect(b.callAmount).toBe(500);
    expect(b.minBetTo).toBe(1000); // 上乗せ 500 の倍返し
    expect(b.maxBetTo).toBe(19800);
  });
});

describe('parseAction: ハンドの終わり方', () => {
  it('フォールドで終わり、降りた席が分かる', () => {
    const s = st('b200f');
    expect(s.toAct).toBe(-1);
    expect(s.folded).toBe(true);
    expect(s.folder).toBe(0); // b200 は SB。降りたのは BB。
    expect(potOf(s)).toBe(300);
    expect(legalActions(s).canFold).toBe(false);
  });

  it('チェックできる場面でのフォールドは弾く', () => {
    expect(errOf('b200c/f')).toBe('フォールドできない場面です');
  });

  it('リバーのチェック回しでショーダウン', () => {
    const s = st('b200c/kk/kk/kk');
    expect(s.toAct).toBe(-1);
    expect(s.folded).toBe(false);
    expect(s.allIn).toBe(false);
    expect(potOf(s)).toBe(400);
  });

  it('オールインコールはショーダウンまで飛び、両者 20000 拠出になる', () => {
    const s = st('b20000c');
    expect(s.toAct).toBe(-1);
    expect(s.allIn).toBe(true);
    expect(s.street).toBe(3);
    expect(committed(s, 0)).toBe(STACK);
    expect(committed(s, 1)).toBe(STACK);
    expect(potOf(s)).toBe(2 * STACK);
  });

  it('オールインコールの後ろに残ストリート分の `/` が付いた形も受ける', () => {
    const s = st('b20000c///');
    expect(s.toAct).toBe(-1);
    expect(s.allIn).toBe(true);
    expect(potOf(s)).toBe(2 * STACK);
  });

  it('オールインコールの後ろに余計な文字が来たら弾く', () => {
    expect(errOf('b20000ck')).toBe('ストリート区切りがありません');
  });
});

describe('parseAction: スタックが尽きかけた境界', () => {
  it('ミニマムレイズ幅が残りチップを超えるときはオールインだけが選べる', () => {
    // SB が 199.5bb まで上げると、上乗せ幅(198.5bb)より残り(0.5bb)の方が小さい。
    const s = st('b19950');
    const a = legalActions(s);
    expect(a.callAmount).toBe(19850);
    expect(a.canBet).toBe(true);
    expect(a.minBetTo).toBe(STACK); // ミニマムレイズがオールインに丸められる
    expect(a.maxBetTo).toBe(STACK);
    expect(parseAction('b19950b20000').ok).toBe(true);
    expect(errOf('b19950b19999')).toBe('ベットが小さすぎます');
  });

  it('ポストフロップのオールインコール（前ストリートの拠出がある状態）', () => {
    const s = st('b200c/b19800c');
    expect(s.toAct).toBe(-1);
    expect(s.allIn).toBe(true);
    expect(s.street).toBe(3);
    expect(committed(s, 0)).toBe(STACK);
    expect(committed(s, 1)).toBe(STACK);
    expect(potOf(s)).toBe(2 * STACK);
  });

  it('オールインに降りたときのポットは「オールイン額＋ブラインド」', () => {
    const s = st('b20000f');
    expect(s.folded).toBe(true);
    expect(s.folder).toBe(0); // 降りたのは BB
    expect(committed(s, 0)).toBe(BB);
    expect(committed(s, 1)).toBe(STACK);
    expect(potOf(s)).toBe(STACK + BB);
  });
});

describe('parseAction: 実際に Slumbot が返してきた文字列', () => {
  // 実測ログから採取（このアプリの調査セッションで API を叩いて得たもの）。
  it('b200c/kb200c/kk/kb200c — 4ストリート打ち切りまで復元できる', () => {
    const s = st('b200c/kb200c/kk/kb200c');
    expect(s.toAct).toBe(-1);
    expect(s.street).toBe(3);
    // preflop 200 / flop 200 / turn 0 / river 200 を両者ぶん。
    expect(potOf(s)).toBe((200 + 200 + 200) * 2);
  });

  it('途中局面 b200c/kb200 は「BB チェック → SB ベット」で BB の手番', () => {
    const s = st('b200c/kb200');
    expect(s.street).toBe(1);
    expect(s.toAct).toBe(0);
    expect(s.streetBet).toEqual([0, 200]);
    const a = legalActions(s);
    expect(a.callAmount).toBe(200);
    expect(a.canFold).toBe(true);
    expect(a.minBetTo).toBe(400);
  });
});

describe('表示ヘルパ', () => {
  it('bbLabel は末尾の 0 を落とす', () => {
    expect(bbLabel(100)).toBe('1');
    expect(bbLabel(150)).toBe('1.5');
    expect(bbLabel(230)).toBe('2.3');
    expect(bbLabel(20000)).toBe('200');
    expect(bbLabel(0)).toBe('0');
  });

  it('signedBbLabel は符号を付ける', () => {
    expect(signedBbLabel(400)).toBe('+4');
    expect(signedBbLabel(-150)).toBe('−1.5');
    expect(signedBbLabel(0)).toBe('±0');
  });
});
