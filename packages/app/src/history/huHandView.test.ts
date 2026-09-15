import { describe, expect, it } from 'vitest';

import type { HuHandRecord } from '../slumbot/history';
import { toTenfourHand } from '../slumbot/tenfour';
import { huHandView } from './huHandView';

const played = new Date(2026, 8, 15, 21, 17, 0).getTime();

function rec(over: Partial<HuHandRecord>): HuHandRecord {
  return {
    id: 'sb_test0001',
    playedAt: played,
    heroSeat: 0,
    action: 'ck/kk/kk/kk',
    heroCards: ['Ah', 'Kd'],
    botCards: null,
    board: ['2s', '7h', 'Tc', '4d', '9c'],
    winnings: 100,
    showdown: true,
    evWinnings: 100,
    synced: true,
    ...over,
  };
}

describe('huHandView', () => {
  it('リンプ→ショーダウン（人手検算: 各ストリートのポットは 1.5 / 2 / 2 / 2bb）', () => {
    const v = huHandView(rec({ botCards: ['Qc', 'Qd'] }))!;
    expect(v.key).toBe('sb_test0001');
    expect(v.title).toBe('9/15 21:17');
    expect(v.subtitle).toBe('200bb スタート');
    expect(v.heroCards).toEqual(['Ah', 'Kd']);

    // players は SB→BB の順。ヒーローは BB。
    expect(v.players).toEqual([
      { seat: 1, pos: 'SB', name: 'SLUMBOT', isHero: false, netBb: -1, cards: ['Qc', 'Qd'] },
      { seat: 0, pos: 'BB', name: 'YOU', isHero: true, netBb: 1, cards: ['Ah', 'Kd'] },
    ]);

    // 手計算: プリフロップはブラインドのみ＝1.5bb。SB のコール(50→100)でフロップ開始は
    // 100(BB)+100(SB)=200チップ=2bb。以降は全員チェックなので変わらず 2bb のまま。
    expect(v.streets.map((s) => [s.label, s.potBb])).toEqual([
      ['PREFLOP', 1.5],
      ['FLOP', 2],
      ['TURN', 2],
      ['RIVER', 2],
    ]);
    expect(v.streets[0]!.board).toEqual([]);
    expect(v.streets[1]!.board).toEqual(['2s', '7h', 'Tc']);
    expect(v.streets[2]!.board).toEqual(['4d']);
    expect(v.streets[3]!.board).toEqual(['9c']);

    expect(v.streets[0]!.steps).toEqual([
      { pos: 'SB', name: 'SLUMBOT', isHero: false, label: 'CALL', amountBb: 1, allIn: false, auto: false },
      { pos: 'BB', name: 'YOU', isHero: true, label: 'CHECK', amountBb: null, allIn: false, auto: false },
    ]);
    expect(v.streets[3]!.steps).toEqual([
      { pos: 'BB', name: 'YOU', isHero: true, label: 'CHECK', amountBb: null, allIn: false, auto: false },
      { pos: 'SB', name: 'SLUMBOT', isHero: false, label: 'CHECK', amountBb: null, allIn: false, auto: false },
    ]);

    // 両者とも 1bb ずつ出し合って（コール済み）ショーダウンなので、最終ポットと
    // 持ち帰りは一致する＝ finalPotBb は wonBb と同じ 2bb（上乗せの返還は発生しない）。
    expect(v.result).toEqual({
      winners: ['YOU'],
      wonBb: 2,
      showdown: true,
      finalPotBb: 2,
      notes: [],
    });
  });

  it('プリフロップの捲り合い（人手検算: フロップ以降のポットは 400bb・EV 差 -150bb）', () => {
    const v = huHandView(
      rec({
        heroSeat: 0,
        action: 'b20000c',
        botCards: ['Qh', 'Qc'],
        winnings: 20000,
        evWinnings: 5000,
      }),
    )!;
    // 手計算: SB が 20000 までオールイン(put 19950)・BB がコール(put 19900)。
    // プリフロップの 150 チップに加えて 40000 チップ＝400bb がフロップ開始のポット。
    expect(v.streets.map((s) => [s.label, s.potBb])).toEqual([
      ['PREFLOP', 1.5],
      ['FLOP', 400],
      ['TURN', 400],
      ['RIVER', 400],
    ]);
    expect(v.streets[0]!.steps).toEqual([
      { pos: 'SB', name: 'SLUMBOT', isHero: false, label: 'ALL IN', amountBb: 200, allIn: true, auto: false },
      { pos: 'BB', name: 'YOU', isHero: true, label: 'ALL IN', amountBb: 200, allIn: true, auto: false },
    ]);
    expect(v.result.finalPotBb).toBe(400);
    expect(v.result.wonBb).toBe(400);
    expect(v.result.showdown).toBe(true);
    // 実収支 200bb・EV 収支 50bb の差＝ -150bb。
    expect(v.result.notes).toEqual(['ALL-IN EV −150bb']);
  });

  it('プリフロップ fold で終了（人手検算: ストリート開始ポットは 1.5bb・持ち帰り＝最終ポットは 1bb）', () => {
    const v = huHandView(
      rec({
        heroSeat: 1,
        action: 'f',
        botCards: null,
        board: [],
        winnings: -50,
        evWinnings: -50,
        showdown: false,
      }),
    )!;
    // ストリート開始時点のポット（1.5bb＝SB50+BB100）はそのまま。ただし実際に奪い合われた
    // のは SB の 50 チップ（=0.5bb）だけなので、コールされずに戻った BB の上乗せ分は
    // finalPotBb には数えない＝ committed の合計（1.5bb）より小さい wonBb と同じ 1bb になる。
    expect(v.streets).toHaveLength(1);
    expect(v.streets[0]).toMatchObject({ street: 0, label: 'PREFLOP', potBb: 1.5, board: [] });
    expect(v.streets[0]!.steps).toEqual([
      { pos: 'SB', name: 'YOU', isHero: true, label: 'FOLD', amountBb: null, allIn: false, auto: false },
    ]);
    expect(v.players).toEqual([
      { seat: 1, pos: 'SB', name: 'YOU', isHero: true, netBb: -0.5, cards: ['Ah', 'Kd'] },
      { seat: 0, pos: 'BB', name: 'SLUMBOT', isHero: false, netBb: 0.5, cards: null },
    ]);
    expect(v.result).toEqual({
      winners: ['SLUMBOT'],
      wonBb: 1,
      showdown: false,
      finalPotBb: 1,
      notes: [],
    });
    expect(v.result.finalPotBb).toBe(v.result.wonBb);
  });

  it('リバーのベットが降ろして終わったハンド（人手検算: 上乗せの 300 は戻るので finalPotBb は committed の合計 5bb より小さい 2bb）', () => {
    const v = huHandView(
      rec({
        heroSeat: 0,
        action: 'ck/kk/kk/b300f',
        botCards: null,
        winnings: 100,
        evWinnings: 100,
        showdown: false,
      }),
    )!;
    // 手計算: プリフロップ〜ターンは両者 100 チップずつ(carry=[100,100])。リバーで BB
    // （ヒーロー）が 300 まで bet、SB は fold。streetBet は BB=300 だけ乗って carry には
    // 畳まれないので committed(fin,BB)=100+300=400・committed(fin,SB)=100+0=100（合計 5bb）
    // ＝古い定義だとここが finalPotBb だった。実際に奪い合われたのは 2×min(400,100)=200
    // チップ＝2bb（コールされなかった 300 の上乗せは戻る分なので数えない）。
    expect(v.streets.map((s) => s.potBb)).toEqual([1.5, 2, 2, 2]);
    expect(v.result.wonBb).toBe(2);
    expect(v.result.finalPotBb).toBe(2);
    expect(v.result.finalPotBb).toBeLessThan(5); // committed の合計（4bb+1bb=5bb）より小さい。
  });

  it('壊れた action 文字列は null', () => {
    expect(huHandView(rec({ action: 'kk' }))).toBeNull();
  });

  it('契約: streets の potBb は toTenfourHand の street_pots（flop/turn/river）と一致する', () => {
    const r = rec({
      heroSeat: 1,
      action: 'b200c/kb300c/kk/b900f',
      botCards: null,
      winnings: -450,
      evWinnings: -450,
      showdown: false,
    });
    const v = huHandView(r)!;
    const t = toTenfourHand(r, 'YOU', played)!;
    const byLabel = new Map(v.streets.map((s) => [s.label, s.potBb]));
    expect(byLabel.get('FLOP')).toBe(t.street_pots.flop);
    expect(byLabel.get('TURN')).toBe(t.street_pots.turn);
    expect(byLabel.get('RIVER')).toBe(t.street_pots.river);
  });
});
