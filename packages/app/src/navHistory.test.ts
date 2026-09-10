import { describe, expect, it } from 'vitest';

import {
  createBackController,
  depthOfState,
  NAV_DEPTH_KEY,
  planHistorySync,
  type HistoryLike,
} from './navHistory';

/**
 * ブラウザの履歴スタックを模した差し替え。go() は実ブラウザ同様に非同期で、
 * 何回呼ばれても popstate は1回だけ発火する（delivery() で明示的に配送する）。
 */
class FakeHistory implements HistoryLike {
  entries: unknown[] = [null];
  index = 0;
  private pending = 0;

  get state(): unknown {
    return this.entries[this.index];
  }

  pushState(data: unknown): void {
    this.entries = this.entries.slice(0, this.index + 1);
    this.entries.push(data);
    this.index += 1;
  }

  go(delta: number): void {
    const next = this.index + delta;
    if (next < 0) throw new Error('履歴の外へ出た＝アプリ離脱');
    this.index = next;
    this.pending += 1;
  }

  /** 端末の戻る1回ぶん。履歴の先頭で押されたら離脱（=アプリ終了）。 */
  pressBack(): 'exit' | 'pop' {
    if (this.index === 0) return 'exit';
    this.index -= 1;
    this.pending += 1;
    return 'pop';
  }

  /** 保留中の popstate を1件配送する。無ければ false。 */
  deliver(ctl: { handlePop(): boolean }): boolean | null {
    if (this.pending === 0) return null;
    this.pending -= 1;
    return ctl.handlePop();
  }
}

describe('depthOfState', () => {
  it('自分が積んだ印だけを深さとして読む', () => {
    expect(depthOfState(null)).toBe(0);
    expect(depthOfState(undefined)).toBe(0);
    expect(depthOfState({ other: 3 })).toBe(0);
    expect(depthOfState({ [NAV_DEPTH_KEY]: 2 })).toBe(2);
    expect(depthOfState({ [NAV_DEPTH_KEY]: -1 })).toBe(0);
    expect(depthOfState({ [NAV_DEPTH_KEY]: 'x' })).toBe(0);
  });
});

describe('planHistorySync', () => {
  it('深さの差を push / go の数に変換する', () => {
    expect(planHistorySync(0, 0)).toBe(0);
    expect(planHistorySync(0, 2)).toBe(2);
    expect(planHistorySync(2, 1)).toBe(-1);
    expect(planHistorySync(3, 0)).toBe(-3);
  });
});

describe('createBackController', () => {
  it('ルート（深さ0）では履歴を積まない＝端末の戻るは従来どおりアプリ終了', () => {
    const h = new FakeHistory();
    const ctl = createBackController(h);
    ctl.sync(0);
    expect(h.entries).toHaveLength(1);
    expect(h.pressBack()).toBe('exit');
  });

  it('画面が深くなった分だけダミーを積む', () => {
    const h = new FakeHistory();
    const ctl = createBackController(h);
    ctl.sync(1);
    expect(h.entries).toHaveLength(2);
    ctl.sync(2);
    expect(h.entries).toHaveLength(3);
    expect(ctl.depth).toBe(2);
  });

  it('端末の戻るはアプリ内の1階層戻るに翻訳され、アプリは終了しない', () => {
    const h = new FakeHistory();
    const ctl = createBackController(h);
    ctl.sync(1); // 例: ホーム → スレッド

    expect(h.pressBack()).toBe('pop'); // 終了しない
    expect(h.deliver(ctl)).toBe(true); // アプリ側を1階層戻せ
    ctl.sync(0); // 戻った結果の深さを反映
    expect(ctl.depth).toBe(0);
    expect(h.index).toBe(0);
    expect(h.pressBack()).toBe('exit'); // ルートまで戻ったら次で終了
  });

  it('2階層潜ってからの端末の戻るは1階層ずつ戻る', () => {
    const h = new FakeHistory();
    const ctl = createBackController(h);
    ctl.sync(1); // 記録タブ
    ctl.sync(2); // 結果画面

    expect(h.pressBack()).toBe('pop');
    expect(h.deliver(ctl)).toBe(true);
    ctl.sync(1);
    expect(ctl.depth).toBe(1);

    expect(h.pressBack()).toBe('pop');
    expect(h.deliver(ctl)).toBe(true);
    ctl.sync(0);
    expect(ctl.depth).toBe(0);
    expect(h.pressBack()).toBe('exit');
  });

  it('画面内の戻るで閉じたら履歴も1つ戻し、その popstate では二重に戻らない', () => {
    const h = new FakeHistory();
    const ctl = createBackController(h);
    ctl.sync(1);

    ctl.sync(0); // ヘッダの ‹ で閉じた
    expect(h.deliver(ctl)).toBe(false); // 自分で起こした popstate は無視
    expect(ctl.depth).toBe(0);
    expect(h.index).toBe(0);
    expect(h.pressBack()).toBe('exit'); // ダミーは残っていない
  });

  it('複数階層を一気に閉じても go は1回・popstate も1回だけ消費する', () => {
    const h = new FakeHistory();
    const ctl = createBackController(h);
    ctl.sync(3);
    expect(h.index).toBe(3);

    ctl.sync(0); // 例: 結果 → 完了トーストからタブへ
    expect(h.index).toBe(0);
    expect(h.deliver(ctl)).toBe(false);
    expect(h.deliver(ctl)).toBe(null); // 追加の popstate は来ない
    expect(ctl.depth).toBe(0);
  });

  it('リロードで残った古いダミーを巻き戻してから開始する（初回 sync で離脱しない）', () => {
    const h = new FakeHistory();
    h.pushState({ [NAV_DEPTH_KEY]: 1 });
    h.pushState({ [NAV_DEPTH_KEY]: 2 });

    const ctl = createBackController(h); // 前回セッションの残骸を巻き戻す
    expect(h.index).toBe(0);
    expect(h.deliver(ctl)).toBe(false);
    expect(ctl.depth).toBe(0);

    expect(() => ctl.sync(0)).not.toThrow(); // 初回 sync が go(-n) を呼ばない
    expect(h.index).toBe(0);
    expect(h.pressBack()).toBe('exit'); // 前方に残った古いエントリは戻る側に影響しない
  });

  it('想定外のズレ（履歴を一気に巻き戻された）でも次の sync で整合する', () => {
    const h = new FakeHistory();
    const ctl = createBackController(h);
    ctl.sync(2);

    h.go(-2); // 履歴メニュー等でまとめて戻された想定
    h.deliver(ctl);
    expect(ctl.depth).toBe(0);

    ctl.sync(2); // アプリはまだ深いままなので積み直す
    expect(h.index).toBe(2);
    expect(depthOfState(h.state)).toBe(2);
  });
});
