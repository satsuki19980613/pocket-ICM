import { describe, expect, it } from 'vitest';

import {
  AUTO_APPLY_WINDOW_MS,
  shouldAutoApply,
  versionFromBundleUrl,
  type UpdateContext,
} from './updatePolicy';

const LAUNCH: UpdateContext = {
  trigger: 'launch',
  manualRequested: false,
  touchedSinceTrigger: false,
  msSinceTrigger: 2_000,
  appIdle: false,
};

const RESUME: UpdateContext = { ...LAUNCH, trigger: 'resume' };

describe('shouldAutoApply', () => {
  it('起動直後で画面を触る前なら、どの画面でも入れ替える（起動直後は失う state が無い）', () => {
    expect(shouldAutoApply(LAUNCH)).toBe(true);
    expect(shouldAutoApply({ ...LAUNCH, appIdle: true })).toBe(true);
  });

  it('起動のあと画面を触っていたら入れ替えない（お知らせにとどめる）', () => {
    expect(shouldAutoApply({ ...LAUNCH, touchedSinceTrigger: true })).toBe(false);
  });

  it('起動から時間が経って届いた更新は、触っていなくても入れ替えない', () => {
    expect(shouldAutoApply({ ...LAUNCH, msSinceTrigger: AUTO_APPLY_WINDOW_MS })).toBe(true);
    expect(shouldAutoApply({ ...LAUNCH, msSinceTrigger: AUTO_APPLY_WINDOW_MS + 1 })).toBe(false);
  });

  it('裏から戻った直後は、入力途中・計算中でなければ入れ替える', () => {
    expect(shouldAutoApply({ ...RESUME, appIdle: true })).toBe(true);
  });

  it('裏から戻った直後でも、入力途中・計算中・対局中なら入れ替えない', () => {
    expect(shouldAutoApply({ ...RESUME, appIdle: false })).toBe(false);
  });

  it('裏から戻ったあと画面を触っていたら入れ替えない', () => {
    expect(shouldAutoApply({ ...RESUME, appIdle: true, touchedSinceTrigger: true })).toBe(false);
  });

  it('設定で「アップデートを確認」を押したときは、触っていても時間が経っていても入れ替える', () => {
    expect(
      shouldAutoApply({
        ...RESUME,
        manualRequested: true,
        touchedSinceTrigger: true,
        msSinceTrigger: AUTO_APPLY_WINDOW_MS * 10,
      }),
    ).toBe(true);
  });
});

describe('versionFromBundleUrl', () => {
  it('本番のエントリバンドル名からハッシュ部分を取る', () => {
    expect(versionFromBundleUrl('https://pocket-icm.wsk641.workers.dev/assets/index-BngS4dus.js')).toBe(
      'BngS4dus',
    );
  });

  it('ハッシュに - や _ が入っていても取れる', () => {
    expect(versionFromBundleUrl('http://127.0.0.1:4173/assets/index-UmpPfs-N.js')).toBe('UmpPfs-N');
    expect(versionFromBundleUrl('http://127.0.0.1:4173/assets/index-a_b.js?v=1')).toBe('a_b');
  });

  it('バンドル前（開発サーバの main.tsx）は dev', () => {
    expect(versionFromBundleUrl('http://localhost:5173/src/main.tsx')).toBe('dev');
    expect(versionFromBundleUrl('http://localhost:5173/src/main.tsx?t=123')).toBe('dev');
  });
});
