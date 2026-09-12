import { describe, expect, it } from 'vitest';

import { DEFAULT_PREFS, loadPrefs, savePrefs } from './prefs';

/** localStorage の代役（読み書きの両方を 1 つの Map で持つ）。 */
function fakeStore(init?: Record<string, string>): Pick<Storage, 'getItem' | 'setItem'> {
  const m = new Map(Object.entries(init ?? {}));
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
  };
}

describe('GamePrefs の保存と復元', () => {
  it('保存していなければ既定（BGM は OFF・曲は未選択）', () => {
    expect(loadPrefs(fakeStore())).toEqual(DEFAULT_PREFS);
    expect(DEFAULT_PREFS.bgmOn).toBe(false);
    expect(DEFAULT_PREFS.bgmTrack).toBeNull();
  });

  it('保存した値がそのまま戻る', () => {
    const store = fakeStore();
    const p = { autoNext: true, revealMs: 300, bgmOn: true, bgmTrack: '02-neon.mp3' };
    savePrefs(store as Storage, p);
    expect(loadPrefs(store)).toEqual(p);
  });

  it('BGM を足す前に保存された設定でも壊れず、BGM は既定（OFF・未選択）になる', () => {
    // v1 の頃の中身（bgmOn / bgmTrack が無い）。キーは prefs.ts と同じもの。
    const store = fakeStore({ 'icm.slumbot.prefs.v1': JSON.stringify({ autoNext: true, revealMs: 1000 }) });
    expect(loadPrefs(store)).toEqual({ autoNext: true, revealMs: 1000, bgmOn: false, bgmTrack: null });
  });

  it('壊れた値は既定に落とす', () => {
    const store = fakeStore({
      'icm.slumbot.prefs.v1': '{"autoNext":"yes","revealMs":77,"bgmOn":1,"bgmTrack":7}',
    });
    expect(loadPrefs(store)).toEqual(DEFAULT_PREFS);
  });
});
