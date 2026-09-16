import { describe, expect, it } from 'vitest';

import { engine } from '../engine';
import { ACTION_MS, AUTO_TO_SITOUT, WAITING_EXPIRES_MS } from '../types';
import { act, actCheckOrCallUntil, currentActorUserId, defaultConfig, makeRng, startTable } from './testKit';

describe('満席で自動開始', () => {
  it('6人揃った瞬間に running・最初のハンドが配られる', () => {
    const { state } = startTable(defaultConfig(), 42);
    expect(state.status).toBe('running');
    expect(state.startedAt).not.toBeNull();
    expect(state.handNo).toBe(1);
    expect(state.hand).not.toBeNull();
    expect(Object.keys(state.hand!.hole)).toHaveLength(6);
    expect(state.players).toHaveLength(6);
    // 席は 0..5 に固定される。
    expect(state.players.map((p) => p.seat).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('満席前は waiting のまま・lobby_changed が飛ぶ', () => {
    const rng = makeRng(1);
    let state = engine.createTable('sg_x', 'u0', 'Host', defaultConfig(), 0);
    const r = engine.apply(state, { t: 'join', userId: 'u1', name: 'P1' }, 0, rng);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.state.status).toBe('waiting');
      expect(r.effects).toContainEqual({ t: 'lobby_changed' });
    }
  });
});

describe('HU（2人）', () => {
  it('btn === sbSeat', () => {
    const { state } = startTable(defaultConfig({ players: 2, startBb: 100 }), 7);
    expect(state.hand!.btn).toBe(state.hand!.sbSeat);
  });
});

describe('act の検証', () => {
  it('handNo/actSeq がズレていれば stale', () => {
    const { state, rng } = startTable(defaultConfig(), 3);
    const hand = state.hand!;
    const userId = currentActorUserId(state);
    const r = engine.apply(state, { t: 'act', userId, handNo: hand.handNo, actSeq: hand.actSeq + 1, kind: 'fold' }, 0, rng);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('stale');
  });

  it('手番でない人が act すると not_your_turn', () => {
    const { state, rng } = startTable(defaultConfig(), 3);
    const hand = state.hand!;
    const actor = currentActorUserId(state);
    const other = state.players.find((p) => p.userId !== actor)!.userId;
    const r = engine.apply(state, { t: 'act', userId: other, handNo: hand.handNo, actSeq: hand.actSeq, kind: 'fold' }, 0, rng);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('not_your_turn');
  });

  it('合法手でないベット額は illegal', () => {
    const { state, rng } = startTable(defaultConfig(), 3);
    const hand = state.hand!;
    const userId = currentActorUserId(state);
    const r = engine.apply(state, { t: 'act', userId, handNo: hand.handNo, actSeq: hand.actSeq, kind: 'bet', betTo: 1 }, 0, rng);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('illegal');
  });

  it('フォールドが正常に進む（actSeq が進む）', () => {
    const { state, rng } = startTable(defaultConfig(), 3);
    const before = state.hand!.actSeq;
    const state2 = act(state, 0, rng, 'fold');
    expect(state2.hand!.actSeq).toBeGreaterThan(before);
    expect(state2.seq).toBeGreaterThan(state.seq);
  });
});

describe('タイムバンクと自動処理', () => {
  it('期限切れで自動チェック、同じ席が同一ハンド内で2連続タイムアウトすると sitout', () => {
    const { state: started, rng } = startTable(defaultConfig(), 11);
    // bb 席は preflop で最後に動く（誰もレイズしなければチェックできる）→ ここを標的にする。
    const target = started.players.find((p) => p.seat === started.hand!.bbSeat)!.userId;

    // 1手目: プリフロップ、bb 以外を check/call で bb の手番まで進める。
    let state = actCheckOrCallUntil(started, target, 0, rng);
    expect(currentActorUserId(state)).toBe(target);
    // bb をタイムアウトさせる（チェックできるはずなので auto check）。
    let r = engine.apply(state, { t: 'wake' }, state.hand!.deadline! + 1, rng);
    if (!r.ok) throw new Error(r.error);
    state = r.state;
    expect(state.players.find((p) => p.userId === target)!.autoCount).toBe(1);
    expect(state.players.find((p) => p.userId === target)!.status).toBe('active');
    expect(state.hand!.street).toBe(1); // フロップへ進んでいる。

    // 2手目: フロップ、bb 以外（btn から順）を check で bb の手番まで進める。
    state = actCheckOrCallUntil(state, target, 0, rng);
    expect(currentActorUserId(state)).toBe(target);
    r = engine.apply(state, { t: 'wake' }, state.hand!.deadline! + 1, rng);
    if (!r.ok) throw new Error(r.error);
    state = r.state;
    expect(state.players.find((p) => p.userId === target)!.status).toBe('sitout');
  });

  it('手動アクションは 15 秒以内ならタイムバンクを消費しない', () => {
    const { state, rng } = startTable(defaultConfig(), 5);
    const actorId = currentActorUserId(state);
    const before = state.players.find((p) => p.userId === actorId)!.timeBankMs;
    const now = 5_000; // ACTION_MS(15000) 以内。
    const state2 = act(state, now, rng, 'fold');
    const after = state2.players.find((p) => p.userId === actorId)!;
    expect(after.timeBankMs).toBe(before);
  });

  it('15 秒を超えた分だけタイムバンクを削る', () => {
    const { state, rng } = startTable(defaultConfig(), 5);
    const actorId = currentActorUserId(state);
    const before = state.players.find((p) => p.userId === actorId)!.timeBankMs;
    const now = ACTION_MS + 4_000; // 4 秒分オーバー。
    const state2 = act(state, now, rng, 'fold');
    const after = state2.players.find((p) => p.userId === actorId)!;
    expect(after.timeBankMs).toBe(before - 4_000);
  });
});

describe('待機・一時停止のタイムアウト', () => {
  it('waiting_expired で cancelled', () => {
    const rng = makeRng(1);
    const state = engine.createTable('sg_x', 'u0', 'Host', defaultConfig(), 0);
    const r = engine.apply(state, { t: 'wake' }, WAITING_EXPIRES_MS + 1, rng);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.state.status).toBe('cancelled');
      expect(r.effects.some((e) => e.t === 'game_over')).toBe(true);
    }
  });

  it('作成者が waiting 中に leave すると cancelled', () => {
    const rng = makeRng(1);
    let state = engine.createTable('sg_x', 'u0', 'Host', defaultConfig(), 0);
    const j = engine.apply(state, { t: 'join', userId: 'u1', name: 'P1' }, 0, rng);
    if (!j.ok) throw new Error();
    state = j.state;
    const r = engine.apply(state, { t: 'leave', userId: 'u0' }, 0, rng);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.status).toBe('cancelled');
  });

  it('生存者全員が未接続なら次のハンド送りで paused、10 分で cancelled', () => {
    const { state: started, rng } = startTable(defaultConfig({ players: 2 }), 21);
    // 全員を未接続にする（アクティブでも「戻る見込みなし」として扱われる）。
    let state = started;
    for (const p of state.players) {
      const r = engine.apply(state, { t: 'connected', userId: p.userId, connected: false }, 0, rng);
      if (!r.ok) throw new Error(r.error);
      state = r.state;
    }
    expect(state.status).toBe('running'); // 進行中のハンドはそのまま続く。

    // 今のハンドをフォールドで終わらせて次のハンド送りへ。
    state = act(state, 0, rng, 'fold');
    expect(state.hand!.phase).toBe('settled');

    const r2 = engine.apply(state, { t: 'wake' }, state.wake!.at, rng);
    if (!r2.ok) throw new Error(r2.error);
    state = r2.state;
    expect(state.status).toBe('paused');
    expect(state.wake!.kind).toBe('paused_expired');

    const r3 = engine.apply(state, { t: 'wake' }, state.wake!.at + 1, rng);
    expect(r3.ok).toBe(true);
    if (r3.ok) expect(r3.state.status).toBe('cancelled');
  });
});

describe('離席', () => {
  it('生存者(active/sitout)が1人になったら即終了・勝者に place=1', () => {
    const { state, rng } = startTable(defaultConfig({ players: 2 }), 8);
    const other = state.players.find((p) => p.userId !== 'u0')!.userId;
    const r = engine.apply(state, { t: 'leave', userId: other }, 0, rng);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.state.status).toBe('finished');
      const winner = r.state.players.find((p) => p.userId === 'u0')!;
      expect(winner.place).toBe(1);
      expect(r.effects.some((e) => e.t === 'game_over')).toBe(true);
    }
  });
});

describe('秘密の非漏洩', () => {
  it('publicTable の JSON に自分以外の手札が含まれない', () => {
    const { state } = startTable(defaultConfig(), 13);
    const pub = engine.publicTable(state);
    const json = JSON.stringify(pub);
    expect(json.includes('"deck"')).toBe(false);
    // 公開された shown 以外の手札は載らない（このハンドはまだショーダウン前なので shown は空）。
    expect(pub.hand!.shown).toEqual({});
    // 各プレイヤーの実際の手札文字列がどこにも出ていないことを、直接 you() 経由で取得して確認する。
    for (const p of state.players) {
      const you = engine.you(state, p.userId);
      if (you.hole) {
        const [c1, c2] = you.hole;
        // 他人の hole は publicTable 側の JSON に出てこないはず。自分の分だけ数える。
        const occurrences = json.split(c1 + c2).length - 1;
        expect(occurrences).toBe(0);
      }
    }
  });
});

describe('レベル', () => {
  it('levelAt は経過時間から求まり、次のレベルへ切り替わる', () => {
    const config = defaultConfig({ levelMin: 3 });
    const startedAt = 0;
    expect(engine.levelAt(config, startedAt, 0)).toBe(1);
    expect(engine.levelAt(config, startedAt, 3 * 60_000 - 1)).toBe(1);
    expect(engine.levelAt(config, startedAt, 3 * 60_000)).toBe(2);
  });
});

// アバター枠＋バッジ（frameColor/specialFrame/badge）の配線。worker/sng/table.ts が毎回
// auth 由来の値を渡す想定で、avatarUrl と全く同じ扱い（省略時は null）にしてある。
describe('createTable/join のアバター枠＋バッジ', () => {
  it('createTable は hostFrameColor/hostSpecialFrame/hostBadge をそのまま host に載せる', () => {
    const state = engine.createTable('sg_x', 'u0', 'Host', defaultConfig(), 0, null, 'cyan', null, 'crab');
    expect(state.players[0]!.frameColor).toBe('cyan');
    expect(state.players[0]!.specialFrame).toBeNull();
    expect(state.players[0]!.badge).toBe('crab');
  });

  it('省略時はどれも null（テスト等・古い呼び出し元でも落ちない）', () => {
    const state = engine.createTable('sg_x', 'u0', 'Host', defaultConfig(), 0);
    expect(state.players[0]!.frameColor).toBeNull();
    expect(state.players[0]!.specialFrame).toBeNull();
    expect(state.players[0]!.badge).toBeNull();
  });

  it('join コマンドの frameColor/specialFrame/badge が新規プレイヤーへそのまま載る', () => {
    const rng = makeRng(1);
    const state = engine.createTable('sg_x', 'u0', 'Host', defaultConfig(), 0);
    const r = engine.apply(
      state,
      { t: 'join', userId: 'u1', name: 'P1', frameColor: 'special', specialFrame: '#f5c542', badge: 'crab' },
      0,
      rng,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const p1 = r.state.players.find((p) => p.userId === 'u1');
      expect(p1?.frameColor).toBe('special');
      expect(p1?.specialFrame).toBe('#f5c542');
      expect(p1?.badge).toBe('crab');
    }
  });

  it('waiting 中の再入室のたびに frameColor/specialFrame/badge も今の値へ揃える', () => {
    const rng = makeRng(1);
    let state = engine.createTable('sg_x', 'u0', 'Host', defaultConfig(), 0, null, 'steel');
    const joined = engine.apply(state, { t: 'join', userId: 'u1', name: 'P1', frameColor: 'red' }, 0, rng);
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    state = joined.state;
    // u1 が枠を変えてから同じ部屋に再入室（waiting のまま）。
    const rejoined = engine.apply(state, { t: 'join', userId: 'u1', name: 'P1', frameColor: 'yellow', badge: 'crab' }, 0, rng);
    expect(rejoined.ok).toBe(true);
    if (rejoined.ok) {
      const p1 = rejoined.state.players.find((p) => p.userId === 'u1');
      expect(p1?.frameColor).toBe('yellow');
      expect(p1?.badge).toBe('crab');
    }
  });
});
