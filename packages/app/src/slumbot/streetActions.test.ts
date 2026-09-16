import { describe, expect, it } from 'vitest';

import { describeLastAction } from './hand';
import { lastActionsOnStreet, listActions } from './streetActions';

// このファイルの期待値はすべて `npx vitest run` で実行した実測値。
// parseAction / describeLastAction を直接叩いて確かめた事実だけを書いている
// （思い込みで期待値を先に決めていない）。

describe('listActions', () => {
  it('空文字列は空配列', () => {
    expect(listActions('')).toEqual([]);
  });

  it('プリフロップのレイズ→コール（b200c）は 2 手、どちらも street 0', () => {
    const actions = listActions('b200c');
    expect(actions).toHaveLength(2);

    // 席 1（SB/BTN）のオープンレイズ → 席 0（BB）のコール、の順で並ぶ。
    expect(actions[0]).toMatchObject({ street: 0, seat: 1, kind: 'raise', betTo: 200, allIn: false });
    expect(actions[1]).toMatchObject({ street: 0, seat: 0, kind: 'call', betTo: 200, allIn: false });
  });

  it('ストリートをまたぐ（b200c/kb300c）は street 0 に 2 手・street 1 に 3 手', () => {
    const actions = listActions('b200c/kb300c');
    expect(actions.map((a) => a.street)).toEqual([0, 0, 1, 1, 1]);

    // street 1: 席 0 が先手チェック → 席 1 がベット → 席 0 がコール。
    expect(actions[2]).toMatchObject({ street: 1, seat: 0, kind: 'check', betTo: 0 });
    expect(actions[3]).toMatchObject({ street: 1, seat: 1, kind: 'bet', betTo: 300 });
    expect(actions[4]).toMatchObject({ street: 1, seat: 0, kind: 'call', betTo: 300 });
  });

  it('末尾の / があっても同じ結果になる', () => {
    expect(listActions('b200c/')).toEqual(listActions('b200c'));
  });

  it('同じストリートで同じ席が 2 回打つ（4-bet ポット）', () => {
    // b200(seat1 raise) b600(seat0 raise) b1800(seat1 再レイズ) c(seat0 call)
    const actions = listActions('b200b600b1800c');
    expect(actions).toHaveLength(4);
    expect(actions.map((a) => a.seat)).toEqual([1, 0, 1, 0]);
    expect(actions.map((a) => a.betTo)).toEqual([200, 600, 1800, 1800]);
    expect(actions.every((a) => a.street === 0)).toBe(true);
  });

  it('全部入れる bet は allIn=true になり、describeLastAction のラベルと一致する（ALL IN 表記）', () => {
    const actions = listActions('b20000c');
    expect(actions).toHaveLength(2);

    const allIn = actions[0]!;
    expect(allIn).toMatchObject({ seat: 1, kind: 'raise', betTo: 20000, allIn: true });
    expect(allIn.label.startsWith('ALL IN')).toBe(true);

    // 追いかけたコール自体はオールインでも allIn フラグは立てない（bet/raise 専用の判定のため）。
    const call = actions[1]!;
    expect(call).toMatchObject({ seat: 0, kind: 'call', betTo: 20000, allIn: false, street: 0 });
  });

  it('通常サイズの bet/raise では allIn=false のまま', () => {
    const actions = listActions('b200b600b1800c');
    expect(actions.every((a) => a.allIn === false)).toBe(true);
  });

  it('フォールド決着（b200f）も 2 手として復元できる', () => {
    const actions = listActions('b200f');
    expect(actions).toEqual([
      expect.objectContaining({ street: 0, seat: 1, kind: 'raise', betTo: 200 }),
      expect.objectContaining({ street: 0, seat: 0, kind: 'fold', betTo: 0 }),
    ]);
  });

  it('未知の文字で壊れた文字列（b200x）はそこまでの分だけ返す', () => {
    const actions = listActions('b200x');
    expect(actions).toEqual([expect.objectContaining({ street: 0, seat: 1, kind: 'raise', betTo: 200 })]);
  });

  it('数字が続かない裸の b（bbb）は最初のトークンから壊れているので空配列', () => {
    expect(listActions('bbb')).toEqual([]);
  });
});

describe('listActions の put（実際に出した増分）', () => {
  it('check/fold は put=0', () => {
    const [, foldAction] = listActions('b200f');
    expect(foldAction).toMatchObject({ kind: 'fold', put: 0 });

    const [, , checkAction] = listActions('b200c/k');
    expect(checkAction).toMatchObject({ kind: 'check', put: 0 });
  });

  it('プリフロップ: SB がリンプではなくレイズ、BB がコール → BB の put はブラインドの二重払いにならない', () => {
    // b200c: SB/BTN(seat1) が 200 までレイズ、BB(seat0) がコール。
    const [raise, call] = listActions('b200c');

    // SB はすでに 50 置いているので、レイズでの put は 200-50=150（実測）。
    expect(raise).toMatchObject({ seat: 1, kind: 'raise', betTo: 200, put: 150 });

    // BB はすでに 100 置いているので、コールでの put は 200-100=100。
    // これがブラインド込みの 200 になっていたら二重払いのバグ。
    expect(call).toMatchObject({ seat: 0, kind: 'call', betTo: 200, put: 100 });
  });

  it('ポストフロップ: ベット→レイズ→再レイズ→コールで、再レイズ側の put は「累計額−自分が既に出していた額」', () => {
    // flop: 席0が 300 ベット→席1が 900 にレイズ→席0が 2700 に再レイズ→席1がコール。
    const actions = listActions('b200c/b300b900b2700c');
    const flopActions = actions.filter((a) => a.street === 1);

    expect(flopActions.map((a) => ({ seat: a.seat, kind: a.kind, betTo: a.betTo, put: a.put }))).toEqual([
      { seat: 0, kind: 'bet', betTo: 300, put: 300 }, // 初手なので put=betTo。
      { seat: 1, kind: 'raise', betTo: 900, put: 900 }, // この街まだ 0 円→900 なので put=900。
      // 席0は既にこの街で 300 出しているので、2700 への再レイズの put は 2700-300=2400。
      { seat: 0, kind: 'raise', betTo: 2700, put: 2400 },
      // 席1は既にこの街で 900 出しているので、コールの put は 2700-900=1800。
      { seat: 1, kind: 'call', betTo: 2700, put: 1800 },
    ]);
  });

  it('put は describeLastAction() の CALL ラベルの数値と一致する（式がズレていないことの確認）', () => {
    const action = 'b200c/b300b900b2700c';
    const [call] = [...listActions(action)].slice(-1);
    const described = describeLastAction(action);

    expect(described?.kind).toBe('call');
    // ラベルは "CALL 18bb" のように bb 表記なので、put をチップ→bb に換算した数値と突き合わせる。
    expect(described?.label).toBe('CALL 18bb');
    expect(call!.put).toBe(1800); // 1800 チップ = 18bb で一致。
  });
});

describe('lastActionsOnStreet', () => {
  it('該当ストリートが無ければ空の Map', () => {
    expect(lastActionsOnStreet('', 0).size).toBe(0);
    expect(lastActionsOnStreet('b200c', 1).size).toBe(0);
  });

  it('b200c/kb300c の street 1 は席 0=call(300)・席 1=bet(300) の 2 件（席 0 は bet ではなく call）', () => {
    const map = lastActionsOnStreet('b200c/kb300c', 1);
    expect(map.size).toBe(2);
    // 席 0 は street 1 で「チェック→（相手のベットを受けて）コール」の 2 手を打っているので、
    // 残るのは後の手＝コール。ベットではない。
    expect(map.get(0)).toMatchObject({ kind: 'call', betTo: 300 });
    expect(map.get(1)).toMatchObject({ kind: 'bet', betTo: 300 });
  });

  it('同じ席が同じストリートで 2 回打った場合は後の手だけが残る', () => {
    const map = lastActionsOnStreet('b200b600b1800c', 0);
    expect(map.size).toBe(2);
    // 席 1 は 200 で最初にオープンし、後から 1800 まで再レイズしている。残るのは 1800 の方。
    expect(map.get(1)).toMatchObject({ kind: 'raise', betTo: 1800 });
    expect(map.get(0)).toMatchObject({ kind: 'call', betTo: 1800 });
  });

  it('壊れた文字列でも例外を投げず、有効な分だけを反映する', () => {
    expect(() => lastActionsOnStreet('bbb', 0)).not.toThrow();
    expect(lastActionsOnStreet('bbb', 0).size).toBe(0);

    const map = lastActionsOnStreet('b200x', 0);
    expect(map.get(1)).toMatchObject({ kind: 'raise', betTo: 200 });
  });
});
