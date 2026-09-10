import { describe, expect, it } from 'vitest';

import { screenDepth, type Screen } from './navModel';

/**
 * 各画面の「ヘッダの ‹ / 端末の戻るで行く先」。App.tsx の backFor() と一致していること。
 * 深さは必ず「戻り先の深さ + 1」でなければならない（ズレると戻るが1回空振りする/飛ばす）。
 */
const PARENT: Record<Exclude<Screen, 'home'>, Screen> = {
  icm: 'home',
  training: 'home',
  history: 'home',
  settings: 'home',
  thread: 'home',
  userpub: 'home', // ホームから開いた場合
  confirm: 'icm',
  error: 'icm',
  admin: 'settings',
  slumbot: 'training',
  result: 'history', // スレッド経由でも戻り先は深さ1の thread なので同じ
};

describe('screenDepth', () => {
  it('ホームだけが深さ0（＝端末の戻るでアプリ終了）', () => {
    expect(screenDepth('home')).toBe(0);
  });

  it('どの画面も「戻り先の深さ + 1」になっている', () => {
    for (const [screen, parent] of Object.entries(PARENT) as [Screen, Screen][]) {
      expect(screenDepth(screen), screen).toBe(screenDepth(parent) + 1);
    }
  });

  it('スレッドから開いた公開結果一覧はスレッドの1つ下', () => {
    expect(screenDepth('userpub', { pubFromThread: true })).toBe(screenDepth('thread') + 1);
    expect(screenDepth('userpub', { pubFromThread: false })).toBe(1);
  });

  it('モーダルを重ねた分は呼び出し側で足す前提（画面だけの深さは変わらない）', () => {
    expect(screenDepth('confirm')).toBe(2);
    expect(screenDepth('result')).toBe(2);
  });
});
