import { describe, expect, it } from 'vitest';

import { shouldSeatCheckOnJoin, shouldUnseatOnLeave } from './table';

describe('shouldUnseatOnLeave', () => {
  it('waiting のまま（席が空くだけ）なら外す', () => {
    expect(shouldUnseatOnLeave('waiting')).toBe(true);
  });

  it('running のまま（left・戻れない）でも外す（2026-09-15 実機観察: 試合終了までロビーの' +
    '「参加中の部屋へ戻る」バナーが出続けた問題への対応）', () => {
    expect(shouldUnseatOnLeave('running')).toBe(true);
  });

  it('paused のままでも外す', () => {
    expect(shouldUnseatOnLeave('paused')).toBe(true);
  });

  it('finished（試合終了）は外さない（game_over の notifyLobbyRelease が部屋ごと片付けるため）', () => {
    expect(shouldUnseatOnLeave('finished')).toBe(false);
  });

  it('cancelled（取り消し）は外さない（同上）', () => {
    expect(shouldUnseatOnLeave('cancelled')).toBe(false);
  });
});

describe('shouldSeatCheckOnJoin', () => {
  it('waiting/running/paused では Lobby に確認・登録してよい', () => {
    expect(shouldSeatCheckOnJoin('waiting')).toBe(true);
    expect(shouldSeatCheckOnJoin('running')).toBe(true);
    expect(shouldSeatCheckOnJoin('paused')).toBe(true);
  });

  it('finished/cancelled では確認・登録してはいけない（二度と game_over が来ないので永久に解放されなくなる）', () => {
    expect(shouldSeatCheckOnJoin('finished')).toBe(false);
    expect(shouldSeatCheckOnJoin('cancelled')).toBe(false);
  });
});
