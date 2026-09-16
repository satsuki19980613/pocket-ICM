import type { ActionRecord, SngHandRecord } from '@oshihiki/sng';
import { describe, expect, it } from 'vitest';

import type { SngGameLocal } from '../sng/historyStore';
import { toTenfourSngHand, type SngTenfourMeta } from '../sng/tenfour';
import { sngHandView } from './sngHandView';

const played = new Date(2026, 8, 15, 20, 0, 0).getTime();

function act(seat: number, kind: ActionRecord['kind'], betTo: number, put: number, street = 0): ActionRecord {
  return { seat, kind, betTo, put, auto: false, street };
}

function game(over: Partial<SngGameLocal>): SngGameLocal {
  return {
    gameId: 'sg_test0001',
    config: { players: 3, startBb: 100, speed: 'normal', levelMin: 4, mode: 'club' },
    seats: [],
    status: 'finished',
    startedAt: played - 60_000,
    endedAt: played,
    hands: 5,
    ...over,
  };
}

describe('sngHandView', () => {
  it('アンティ込みのプリフロップ fold（人手検算: ストリート開始ポットは 1.88bb・実際に奪われたのは 1.38bb）', () => {
    const rec: SngHandRecord = {
      gameId: 'sg_test0001',
      handNo: 5,
      playedAt: played,
      level: 2,
      sb: 100,
      bb: 200,
      ante: 25,
      btn: 0,
      sbSeat: 1,
      bbSeat: 2,
      startStacks: [2000, 2000, 2000],
      shown: {},
      board: [],
      actions: [act(0, 'fold', 0, 0, 0), act(1, 'fold', 0, 0, 0)],
      // Σwon=Σcommits（エンジンの実際の書き方）: 唯一の勝者 BB に全拠出額が渡る。
      won: [0, 0, 375],
      eliminated: [],
    };
    const g = game({
      seats: [
        { seat: 0, userId: 'u0', name: 'Bob' },
        { seat: 1, userId: 'u1', name: 'Cara' },
        { seat: 2, userId: 'u2', name: 'Dee' },
      ],
    });
    const v = sngHandView({ rec, game: g, mySeat: 2, handNo: 5, level: 2, myCards: ['Ah', 'Kd'] })!;

    expect(v.key).toBe('sg_test0001_0005');
    expect(v.title).toBe('#5 ・ Level 2');
    expect(v.subtitle).toBe('3人 ・ 100bb開始 ・ 通常 ・ 4分上昇 ・ クラブマッチ');
    expect(v.heroCards).toEqual(['Ah', 'Kd']);

    // 手計算: 各席の拠出は BTN=25（アンティのみ）・SB=125（アンティ25+SB100）・
    // BB=225（アンティ25+BB200）。BB の拠出のうち SB の 125 を超えた 100 は誰にも
    // コールされていない＝実際に奪い合われたのは 375-100=275 チップ＝1.375→1.38bb。
    // 誰もコールしないのでフロップは来ない＝streets は preflop だけ（ここの potBb は
    // 「ストリート開始時点」の規則どおり 375 チップ＝1.88bb のまま・触らない）。
    expect(v.players).toEqual([
      { seat: 0, pos: 'BTN', name: 'Bob', isHero: false, netBb: -0.12, cards: null },
      { seat: 1, pos: 'SB', name: 'Cara', isHero: false, netBb: -0.62, cards: null },
      { seat: 2, pos: 'BB', name: 'YOU', isHero: true, netBb: 0.75, cards: ['Ah', 'Kd'] },
    ]);
    expect(v.streets).toHaveLength(1);
    expect(v.streets[0]).toMatchObject({ street: 0, label: 'PREFLOP', potBb: 1.88, board: [] });
    expect(v.streets[0]!.steps).toEqual([
      { pos: 'BTN', name: 'Bob', isHero: false, label: 'FOLD', amountBb: null, allIn: false, auto: false },
      { pos: 'SB', name: 'Cara', isHero: false, label: 'FOLD', amountBb: null, allIn: false, auto: false },
    ]);
    expect(v.result).toEqual({
      winners: ['YOU'],
      wonBb: 1.38,
      showdown: false,
      finalPotBb: 1.38,
      notes: [],
    });
  });

  it('デッドボタン＋ショーダウン（人手検算: フロップ以降のポットは 2bb）', () => {
    const rec: SngHandRecord = {
      gameId: 'sg_test0002',
      handNo: 12,
      playedAt: played,
      level: 3,
      sb: 100,
      bb: 200,
      ante: 0,
      btn: 2,
      sbSeat: null,
      bbSeat: 4,
      // 席 3 は既に脱落（デッドボタン：本来 SB の枠が空いている）。
      startStacks: [15000, 15000, 15000, 0, 15000, 15000],
      shown: { 2: ['Kh', 'Kd'], 4: ['Ah', 'Ac'] },
      board: ['2s', '7h', 'Tc', '4d', '9c'],
      actions: [
        act(5, 'fold', 0, 0, 0),
        act(0, 'fold', 0, 0, 0),
        act(1, 'fold', 0, 0, 0),
        act(2, 'call', 200, 200, 0),
        act(4, 'check', 0, 0, 0),
        act(4, 'check', 0, 0, 1),
        act(2, 'check', 0, 0, 1),
        act(4, 'check', 0, 0, 2),
        act(2, 'check', 0, 0, 2),
        act(4, 'check', 0, 0, 3),
        act(2, 'check', 0, 0, 3),
      ],
      won: [0, 0, 0, 0, 400, 0],
      eliminated: [],
    };
    const meta: SngTenfourMeta = {
      mySeat: 4,
      myCards: ['Ah', 'Ac'],
      names: ['Zero', 'One', 'Two', 'Three', 'Four', 'Five'],
      playersAtStart: 6,
    };
    const v = sngHandView({ rec, game: null, mySeat: 4, handNo: 12, level: 3, myCards: ['Ah', 'Ac'] })!;

    // 手計算: SB 不在で最初のポットは BB の 200 チップだけ＝1bb。
    // フロップ開始は 200（強制ベット）＋ BTN のコール 200 ＝ 400 チップ＝2bb（以降変化なし）。
    expect(v.players.map((p) => p.pos)).toEqual(['UTG', 'HJ', 'CO', 'BTN', 'BB']);
    expect(v.streets.map((s) => [s.label, s.potBb])).toEqual([
      ['PREFLOP', 1],
      ['FLOP', 2],
      ['TURN', 2],
      ['RIVER', 2],
    ]);
    expect(v.result.showdown).toBe(true);
    expect(v.result.finalPotBb).toBe(2);
    expect(v.result.wonBb).toBe(2);
    expect(v.result.winners).toEqual(['YOU']);

    // 契約: tenfour.ts の street_pots（flop/turn/river）と一致する。
    const t = toTenfourSngHand(rec, meta, 'YOU', played)!;
    const byLabel = new Map(v.streets.map((s) => [s.label, s.potBb]));
    expect(byLabel.get('FLOP')).toBe(t.street_pots.flop);
    expect(byLabel.get('TURN')).toBe(t.street_pots.turn);
    expect(byLabel.get('RIVER')).toBe(t.street_pots.river);
  });

  it('3 人オールイン＋脱落（人手検算: ポットは 30bb、脱落者 2 人分の notes）', () => {
    const rec: SngHandRecord = {
      gameId: 'sg_test0003',
      handNo: 40,
      playedAt: played,
      level: 1,
      sb: 100,
      bb: 200,
      ante: 0,
      btn: 0,
      sbSeat: 1,
      bbSeat: 2,
      startStacks: [2000, 2000, 2000],
      shown: { 0: ['2h', '2d'], 1: ['5h', '5d'], 2: ['Ah', 'Ad'] },
      board: ['2s', '7h', 'Tc', '4d', '9c'],
      actions: [act(0, 'allin', 2000, 2000, 0), act(1, 'allin', 2000, 1900, 0), act(2, 'allin', 2000, 1800, 0)],
      won: [0, 0, 6000],
      eliminated: [
        { seat: 1, place: 2 },
        { seat: 0, place: 3 },
      ],
    };
    const v = sngHandView({ rec, game: null, mySeat: 2, handNo: 40, level: 1 })!;

    // 手計算: 3 人とも 2000 チップを出し合い、合計 6000 チップ＝30bb がそのままポットになる。
    expect(v.streets.map((s) => [s.label, s.potBb])).toEqual([
      ['PREFLOP', 1.5],
      ['FLOP', 30],
      ['TURN', 30],
      ['RIVER', 30],
    ]);
    expect(v.streets[0]!.steps).toEqual([
      { pos: 'BTN', name: 'Seat 0', isHero: false, label: 'ALL IN', amountBb: 10, allIn: true, auto: false },
      { pos: 'SB', name: 'Seat 1', isHero: false, label: 'ALL IN', amountBb: 10, allIn: true, auto: false },
      { pos: 'BB', name: 'YOU', isHero: true, label: 'ALL IN', amountBb: 10, allIn: true, auto: false },
    ]);
    expect(v.result.finalPotBb).toBe(30);
    expect(v.result.wonBb).toBe(30);
    expect(v.result.winners).toEqual(['YOU']);
    expect(v.result.notes).toEqual(['Seat 1 脱落（2位）', 'Seat 0 脱落（3位）']);
    expect(v.subtitle).toBeNull();
    expect(v.heroCards).toEqual(['Ah', 'Ad']);
  });

  // 次の 2 件は won が「エンジンの実際の書き方どおり」（Σwon=Σcommits・未コールの
  // 上乗せも勝者の won に含まれる）でも、finalPotBb/wonBb が正しく上乗せぶんを除いて
  // 出ることを固定値で確かめる。won の合計をそのまま使うと HU で直した膨らみが残って
  // しまう、というコーディネーターの指摘への回帰テスト。
  it('プリフロップ fold で終わったハンド（won の合計を使わないので、未コールの上乗せぶんで finalPotBb は膨らまない）', () => {
    // BTN が 400（2bb）にレイズし、SB・BB とも降りる＝勝者は BTN 1 人。
    // settleUncontested と同じ書き方: 勝者の won には拠出合計がそのまま入る
    // （Σwon=Σcommits）＝ won=[700,0,0]（0+400 の BTN 拠出＋100(SB)＋200(BB)）。
    // 各席の拠出は BTN=400・SB=100・BB=200。BTN の拠出のうち 2 番目に多い BB の 200 を
    // 超えた 200 は誰にもコールされていない＝実際に奪い合われたのは
    // 400+100+200-200=500 チップ＝2.5bb（拠出合計の 700 チップ＝3.5bb より小さい）。
    const rec: SngHandRecord = {
      gameId: 'sg_test0004',
      handNo: 8,
      playedAt: played,
      level: 1,
      sb: 100,
      bb: 200,
      ante: 0,
      btn: 0,
      sbSeat: 1,
      bbSeat: 2,
      startStacks: [2000, 2000, 2000],
      shown: {},
      board: [],
      actions: [act(0, 'raise', 400, 400, 0), act(1, 'fold', 0, 0, 0), act(2, 'fold', 0, 0, 0)],
      won: [700, 0, 0],
      eliminated: [],
    };
    const v = sngHandView({ rec, game: null, mySeat: 0, handNo: 8, level: 1 })!;

    // ストリート開始時点のポット（プリフロップはブラインドのみ＝1.5bb）は今までどおりで
    // 変わらない（コーディネーター指示: ここは触らない）。
    expect(v.streets[0]!.potBb).toBe(1.5);
    expect(v.result.wonBb).toBe(2.5);
    expect(v.result.finalPotBb).toBe(2.5);
    expect(v.result.finalPotBb).toBe(v.result.wonBb);
    expect(v.result.finalPotBb).toBeLessThan(3.5); // 拠出合計（700 チップ）より小さい。
  });

  it('コールされなかった上乗せが戻っただけの席は「獲得」に並べない', () => {
    // BTN が 2000 オールイン、SB(YOU) が持ちぶん 1200 で全額コール、BB は降りる。
    // BTN の 800 は誰にもコールされず戻る＝ settleUncontested と同じ書き方だと
    // won=[800, 2600, 0]（Σwon=Σcommits=3400）になるが、BTN は勝ったのではなく
    // 余りが返っただけ。勝者は YOU 1 人で、獲得は 2600 チップ＝13bb。
    const rec: SngHandRecord = {
      gameId: 'sg_test0007',
      handNo: 11,
      playedAt: played,
      level: 1,
      sb: 100,
      bb: 200,
      ante: 0,
      btn: 0,
      sbSeat: 1,
      bbSeat: 2,
      startStacks: [2000, 1200, 2000],
      shown: {},
      board: [],
      actions: [act(0, 'allin', 2000, 2000, 0), act(1, 'allin', 1200, 1100, 0), act(2, 'fold', 200, 0, 0)],
      won: [800, 2600, 0],
      eliminated: [],
    };
    const v = sngHandView({ rec, game: null, mySeat: 1, handNo: 11, level: 1 })!;

    expect(v.result.winners).toEqual(['YOU']); // BTN を並べない。
    expect(v.result.wonBb).toBe(13);
    expect(v.result.finalPotBb).toBe(13);
  });

  it('リバーのベットが降ろして終わったハンド（won の合計を使わないので、未コールの上乗せぶんで finalPotBb は膨らまない）', () => {
    // BTN はプリフロップで即 fold。SB がコールしてチェックダウンし、リバーで BB が
    // 大きくベットして SB が降りる＝勝者は BB 1 人。各席の拠出は BTN=0・
    // SB=200（forced100+call100）・BB=800（forced200+bet600）。settleUncontested と
    // 同じ書き方で won=[0,0,1000]（Σcommits=0+200+800=1000 がそのまま勝者へ）。
    // BB の拠出のうち SB の 200 を超えた 600 は誰にもコールされていない＝実際に
    // 奪い合われたのは 2×min(200,800)=400 チップ＝2bb（拠出合計の 1000 チップ＝5bb
    // より小さい）。
    const rec: SngHandRecord = {
      gameId: 'sg_test0005',
      handNo: 9,
      playedAt: played,
      level: 1,
      sb: 100,
      bb: 200,
      ante: 0,
      btn: 0,
      sbSeat: 1,
      bbSeat: 2,
      startStacks: [2000, 2000, 2000],
      shown: {},
      board: ['2s', '7h', 'Tc', '4d', '9c'],
      actions: [
        act(0, 'fold', 0, 0, 0),
        act(1, 'call', 200, 100, 0),
        act(2, 'check', 0, 0, 0),
        act(2, 'check', 0, 0, 1),
        act(1, 'check', 0, 0, 1),
        act(2, 'check', 0, 0, 2),
        act(1, 'check', 0, 0, 2),
        act(2, 'bet', 600, 600, 3),
        act(1, 'fold', 0, 0, 3),
      ],
      won: [0, 0, 1000],
      eliminated: [],
    };
    const v = sngHandView({ rec, game: null, mySeat: 2, handNo: 9, level: 1 })!;

    // ストリートごとの開始時点ポットは今までどおり（触らない）。
    expect(v.streets.map((s) => s.potBb)).toEqual([1.5, 2, 2, 2]);
    expect(v.result.wonBb).toBe(2);
    expect(v.result.finalPotBb).toBe(2);
    expect(v.result.finalPotBb).toBe(v.result.wonBb);
    expect(v.result.finalPotBb).toBeLessThan(5); // 拠出合計（1000 チップ）より小さい。
  });

  it('多人数オールイン＋サイドポット（全員がどこかでコールし合っている＝上乗せが無いので finalPotBb === Σcommitted）', () => {
    // BTN・SB は 1500 で対等にオールイン（互いにコールし合っている）。BB は 800 しか
    // 無く、その分だけオールイン（ショートスタックのサイドポット構造）。
    // 各席の拠出は BTN=1500・SB=100(forced)+1400=1500・BB=200(forced)+600=800。
    // 最大拠出（1500）が BTN・SB の 2 席に並ぶので、誰の分も「誰にもコールされて
    // いない」上乗せにはならない（uncalledExcess の amount は 0）。
    // メインポット（800×3=2400）は BB が、サイドポット（(1500-800)×2=1400）は BTN が
    // 取ったとする＝ won=[1400,0,2400]（Σwon=1400+0+2400=3800=Σcommits）。
    const rec: SngHandRecord = {
      gameId: 'sg_test0007',
      handNo: 21,
      playedAt: played,
      level: 4,
      sb: 100,
      bb: 200,
      ante: 0,
      btn: 0,
      sbSeat: 1,
      bbSeat: 2,
      startStacks: [1500, 1500, 800],
      shown: { 0: ['Ah', 'Ad'], 1: ['Kh', 'Kd'], 2: ['Qh', 'Qd'] },
      board: ['2s', '7h', 'Tc', '4d', '9c'],
      actions: [act(0, 'allin', 1500, 1500, 0), act(1, 'allin', 1500, 1400, 0), act(2, 'allin', 800, 600, 0)],
      won: [1400, 0, 2400],
      eliminated: [{ seat: 1, place: 3 }],
    };
    const v = sngHandView({ rec, game: null, mySeat: 2, handNo: 21, level: 4 })!;

    // 手計算: Σcommitted = 1500+1500+800 = 3800 チップ＝19bb。上乗せが無いので
    // finalPotBb はこれとそのまま一致する。
    expect(v.result.finalPotBb).toBe(19);
    expect(v.result.wonBb).toBe(19);
    expect([...v.result.winners].sort()).toEqual(['Seat 0', 'YOU'].sort());
  });

  it('想定外の人数（positionMapOf が null）なら null', () => {
    const rec: SngHandRecord = {
      gameId: 'sg_bad',
      handNo: 1,
      playedAt: played,
      level: 1,
      sb: 100,
      bb: 200,
      ante: 0,
      btn: 0,
      sbSeat: null,
      bbSeat: 0,
      startStacks: [2000],
      shown: {},
      board: [],
      actions: [],
      won: [0],
      eliminated: [],
    };
    expect(sngHandView({ rec, game: null, mySeat: 0, handNo: 1, level: 1 })).toBeNull();
  });
});
