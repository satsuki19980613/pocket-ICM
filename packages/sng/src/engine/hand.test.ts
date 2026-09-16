import { describe, expect, it } from 'vitest';

import type { PlayerState } from '../types';
import { dealHand, applyResolvedAction, resolveAction, settleHand } from './hand';
import { computeLegalActions } from './betting';
import { makeRng } from './testKit';

function makePlayers(stacks: readonly number[]): PlayerState[] {
  return stacks.map((stack, seat) => ({
    userId: `u${seat}`,
    name: `P${seat}`,
    avatarUrl: null,
    seat,
    stack,
    status: 'active',
    connected: true,
    timeBankMs: 30_000,
    autoCount: 0,
    place: null,
    pt: null,
  }));
}

const config = { players: 3 as const, startBb: 100 as const, speed: 'normal' as const, levelMin: 3 as const, mode: 'club' as const };

describe('ショートスタックのアンティ/ブラインド', () => {
  it('sb/bb ともスタック不足なら min(stack,額) で全額オールイン', () => {
    const players = makePlayers([10000, 300, 250]);
    const rng = makeRng(1);
    // level5: sb=390,bb=780,ante=200（BLIND_TABLE_NORMAL[4]）。
    const { hand } = dealHand(players, config, null, null, 1, 5, 0, rng, 0);
    expect(hand.sb).toBe(390);
    expect(hand.bb).toBe(780);
    expect(hand.ante).toBe(200);
    // seat1(sb): stack300 - ante200 = 100 残 → sb は 100 で全額オールイン。
    expect(hand.commits[1]).toBe(300);
    expect(hand.allIn[1]).toBe(true);
    expect(hand.streetBet[1]).toBe(100);
    // seat2(bb): stack250 - ante200 = 50 残 → bb は 50 で全額オールイン。
    expect(hand.commits[2]).toBe(250);
    expect(hand.allIn[2]).toBe(true);
    expect(hand.streetBet[2]).toBe(50);
    // streetLastBetTo は実際に払われた bb 額（50）。
    expect(hand.streetLastBetTo).toBe(50);
    // btn(seat0) はまだ動いていないので手番が回る（自動でショーダウンへ飛ばさない）。
    expect(hand.toAct).toBe(0);
    expect(hand.phase).toBe('betting');
  });
});

function baseHand(overrides: Partial<ReturnType<typeof dealHand>['hand']> = {}) {
  const { hand } = dealHand(makePlayers([20000, 20000, 20000]), config, null, null, 1, 1, 0, makeRng(9), 0);
  return { ...hand, ...overrides };
}

describe('最小レイズと再開しないレイズ', () => {
  it('プリフロップの最小レイズは bb の 2 倍まで（アンティ控除後のスタックが上限）', () => {
    const players = makePlayers([20000, 20000, 20000]);
    const rng = makeRng(2);
    const { hand } = dealHand(players, config, null, null, 1, 1, 0, rng, 0);
    // level1: sb=100,bb=200,ante=50。btn=0,sb=1,bb=2。toAct は nextLive(bb=2) → 0。
    expect(hand.toAct).toBe(0);
    const stack0 = 20000 - hand.commits[0]!; // アンティ 50 控除後。
    const legal = computeLegalActions(hand, 0, stack0);
    expect(legal.betTo).toEqual({ min: 400, max: 20000 - 50 });
  });

  it('最小レイズに満たないオールインは lastBetSize を更新しない（次の最小レイズ幅は縮まらない）', () => {
    // フロップ想定の単純な状況を直接組み立てる: streetLastBetTo=200(seat0のオープンベット)。
    const hand = baseHand({
      street: 1,
      board: ['2h', '7c', 'Jd'],
      streetBet: [200, 0, 0],
      streetLastBetTo: 200,
      lastBetSize: 200,
      startStacks: [20000, 250, 20000],
      commits: [200, 0, 0],
      toAct: 1,
      actions: [{ seat: 0, kind: 'bet', betTo: 200, put: 200, auto: false, street: 1 }],
    });
    const players = makePlayers([20000, 250, 20000]);

    // seat1 が 250 スタック全部でオールイン（コール200は満たすが最小レイズ400には届かない＝250<400）。
    const resolved = resolveAction(hand, 1, 'allin', undefined, 250)!;
    expect(resolved.kind).toBe('allin');
    expect(resolved.betTo).toBe(250);
    const applied = applyResolvedAction(hand, players, 1, resolved, false, 0);

    // streetLastBetTo は 250 まで上がるが、最小レイズ未満のオールインなので lastBetSize は 200 のまま。
    expect(applied.hand.streetLastBetTo).toBe(250);
    expect(applied.hand.lastBetSize).toBe(200);

    // 次に seat2 がレイズするときの最小幅は、250 の shove 幅(50)ではなく元の 200 基準。
    const legal2 = computeLegalActions(applied.hand, 2, 20000);
    expect(legal2.betTo!.min).toBe(250 + 200); // 450。650（250+400）ではない。
  });

  it('通常サイズのオールイン（最小レイズ以上）は lastBetSize を更新する', () => {
    const hand = baseHand({
      street: 1,
      streetBet: [200, 0, 0],
      streetLastBetTo: 200,
      lastBetSize: 200,
      startStacks: [20000, 700, 20000],
      commits: [200, 0, 0],
      toAct: 1,
      actions: [{ seat: 0, kind: 'bet', betTo: 200, put: 200, auto: false, street: 1 }],
    });
    const players = makePlayers([20000, 700, 20000]);
    const resolved = resolveAction(hand, 1, 'allin', undefined, 700)!;
    expect(resolved.betTo).toBe(700); // 200 + 700 = 900 ではなく streetBet(0) + stack(700) = 700。
    const applied = applyResolvedAction(hand, players, 1, resolved, false, 0);
    // inc = 700-200 = 500 >= max(200,200) なので再開する。
    expect(applied.hand.lastBetSize).toBe(500);
  });
});

describe('streetBet は「実際に出した額」（fold/check で書き換わらない）', () => {
  it('レイズに fold した席の streetBet は、そのストリートの最高額ではなく自分が実際に払った額のまま', () => {
    // フロップ: seat0 が 200 まで call 済み、seat1 が 800 にレイズ。seat0 はここで fold。
    const hand = baseHand({
      street: 1,
      board: ['2h', '7c', 'Jd'],
      streetBet: [200, 800, 0],
      streetLastBetTo: 800,
      lastBetSize: 600,
      startStacks: [20000, 20000, 20000],
      commits: [200, 800, 0],
      folded: [false, false, true], // seat2 はプリフロップで既にfold済みの想定
      toAct: 0,
      actions: [
        { seat: 0, kind: 'call', betTo: 200, put: 200, auto: false, street: 1 },
        { seat: 1, kind: 'raise', betTo: 800, put: 800, auto: false, street: 1 },
      ],
    });
    const players = makePlayers([20000, 20000, 20000]);
    const resolved = resolveAction(hand, 0, 'fold', undefined, 20000 - 200)!;
    expect(resolved.kind).toBe('fold');
    const applied = applyResolvedAction(hand, players, 0, resolved, false, 0);
    // fold しただけで 800 を払ったことにしてはいけない。実際に出した 200 のまま。
    expect(applied.hand.streetBet[0]).toBe(200);
    expect(applied.hand.folded[0]).toBe(true);
    // commits も put=0 なので変わらない。
    expect(applied.hand.commits[0]).toBe(200);
  });

  it('check は streetBet を変えない（toCall=0 の場面なので元々 no-op だが明示的に確認）', () => {
    const hand = baseHand({
      street: 1,
      board: ['2h', '7c', 'Jd'],
      streetBet: [0, 0, 0],
      streetLastBetTo: 0,
      lastBetSize: 200,
      startStacks: [20000, 20000, 20000],
      commits: [0, 0, 0],
      folded: [false, false, false],
      toAct: 0,
      actions: [],
    });
    const players = makePlayers([20000, 20000, 20000]);
    const resolved = resolveAction(hand, 0, 'check', undefined, 20000)!;
    const applied = applyResolvedAction(hand, players, 0, resolved, false, 0);
    expect(applied.hand.streetBet[0]).toBe(0);
  });
});

describe('サイドポット（3人オールイン）', () => {
  it('拠出額レイヤごとに勝者が分配され、Σwon=Σcommits', () => {
    const players = makePlayers([1000, 3000, 5000]);
    // 手動でショーダウンまで進んだ HandState を組み立てる。
    const commits = [1000, 3000, 5000];
    const rng = makeRng(4);
    const { hand: dealt } = dealHand(players, { ...config, startBb: 100 }, null, null, 1, 1, 0, rng, 0);
    const hand = {
      ...dealt,
      commits,
      startStacks: [1000, 3000, 5000],
      folded: [false, false, false],
      allIn: [true, true, false],
      hole: { 0: ['Ah', 'Ad'], 1: ['Kh', 'Kd'], 2: ['2h', '2d'] } as Record<number, readonly [string, string]>,
      board: ['Qc', 'Jc', '9c', '4d', '3s'],
      revealed: [],
      phase: 'showdown' as const,
      won: null,
      eliminated: [],
    };
    const settled = settleHand(hand, players, 'club');
    const totalCommits = commits.reduce((a, b) => a + b, 0);
    const totalWon = settled.hand.won!.reduce((a, b) => a + b, 0);
    expect(totalWon).toBe(totalCommits);
    // seat0 は AA で最強のはずなので、自分のオールイン層(1000×3)は総取り。
    expect(settled.hand.won![0]).toBeGreaterThan(0);
  });
});

describe('脱落順位と pt', () => {
  it('同一ハンドで複数人が飛んだら、ハンド開始時スタックの多い方が上位', () => {
    const players = makePlayers([500, 1500, 20000]);
    const rng = makeRng(5);
    const { hand: dealt } = dealHand(players, config, null, null, 1, 1, 0, rng, 0);
    const hand = {
      ...dealt,
      startStacks: [500, 1500, 20000],
      commits: [500, 1500, 2000],
      folded: [false, false, false],
      allIn: [true, true, false],
      hole: { 0: ['2h', '2d'], 1: ['3h', '3d'], 2: ['Ah', 'Ad'] } as Record<number, readonly [string, string]>,
      board: ['Ac', 'Kc', 'Qc', 'Jd', '4s'],
      revealed: [],
      phase: 'showdown' as const,
      won: null,
      eliminated: [],
    };
    const settled = settleHand(hand, players, 'club');
    // seat2(AA) が全部勝つ想定 → seat0,seat1 は 0 スタックで脱落。
    const p0 = settled.players.find((p) => p.seat === 0)!;
    const p1 = settled.players.find((p) => p.seat === 1)!;
    expect(p0.status).toBe('out');
    expect(p1.status).toBe('out');
    // seat1 の方が開始スタックが多い(1500>500) → より上位（place の数字が小さい）。
    expect(p1.place!).toBeLessThan(p0.place!);
    expect(p0.pt).not.toBeNull();
    expect(p1.pt).not.toBeNull();
  });
});
