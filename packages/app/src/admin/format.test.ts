import { describe, it, expect } from 'vitest';
import {
  seatsRemaining,
  isExpired,
  effectiveStatus,
  canRevoke,
  statusLabelJa,
  summarizeStorage,
  formatBytes,
  summarizeOcrFailures,
  displayModeLabelJa,
  type ImageStatRow,
  type OcrFailureRow,
} from './format';

const NOW = Date.parse('2026-09-04T00:00:00Z');
const FUTURE = '2026-09-10T00:00:00Z';
const PAST = '2026-09-01T00:00:00Z';

describe('seatsRemaining', () => {
  it('残枠は max-current・負にしない', () => {
    expect(seatsRemaining(3, 25)).toBe(22);
    expect(seatsRemaining(25, 25)).toBe(0);
    expect(seatsRemaining(30, 25)).toBe(0);
  });
});

describe('isExpired / effectiveStatus', () => {
  it('未来は未期限・過去は期限切れ', () => {
    expect(isExpired(FUTURE, NOW)).toBe(false);
    expect(isExpired(PAST, NOW)).toBe(true);
  });
  it('未使用×期限切れ = expired、それ以外は素通し', () => {
    expect(effectiveStatus('unused', PAST, NOW)).toBe('expired');
    expect(effectiveStatus('unused', FUTURE, NOW)).toBe('unused');
    expect(effectiveStatus('used', PAST, NOW)).toBe('used');
    expect(effectiveStatus('revoked', FUTURE, NOW)).toBe('revoked');
  });
});

describe('canRevoke', () => {
  it('未使用かつ未期限切れのみ取消可', () => {
    expect(canRevoke('unused', FUTURE, NOW)).toBe(true);
    expect(canRevoke('unused', PAST, NOW)).toBe(false);
    expect(canRevoke('used', FUTURE, NOW)).toBe(false);
    expect(canRevoke('revoked', FUTURE, NOW)).toBe(false);
  });
});

describe('statusLabelJa', () => {
  it('日本語ラベル', () => {
    expect(statusLabelJa('unused')).toBe('未使用');
    expect(statusLabelJa('used')).toBe('使用済み');
    expect(statusLabelJa('revoked')).toBe('取消済み');
    expect(statusLabelJa('expired')).toBe('期限切れ');
  });
});

describe('summarizeStorage', () => {
  const MB = 1024 * 1024;

  it('成功／保護の内訳と余裕を合算する', () => {
    const rows: ImageStatRow[] = [
      { bytes: 100 * MB, protected: false },
      { bytes: 50 * MB, protected: false },
      { bytes: 20 * MB, protected: true },
    ];
    const s = summarizeStorage(rows, 700 * MB, 300 * MB);
    expect(s.totalBytes).toBe(170 * MB);
    expect(s.totalCount).toBe(3);
    expect(s.successBytes).toBe(150 * MB);
    expect(s.successCount).toBe(2);
    expect(s.protectedBytes).toBe(20 * MB);
    expect(s.protectedCount).toBe(1);
    expect(s.headroomBytes).toBe(530 * MB);
    expect(s.protectedWarn).toBe(false);
  });

  it('bytes が null の行は 0 として合算する', () => {
    const rows: ImageStatRow[] = [{ bytes: null, protected: false }];
    const s = summarizeStorage(rows);
    expect(s.totalBytes).toBe(0);
    expect(s.successCount).toBe(1);
  });

  it('総量が上限を超えたら余裕は 0（負にしない）', () => {
    const rows: ImageStatRow[] = [{ bytes: 800 * MB, protected: false }];
    const s = summarizeStorage(rows, 700 * MB, 300 * MB);
    expect(s.headroomBytes).toBe(0);
  });

  it('保護画像だけでしきい値を超えたら警告（§7.2-3）', () => {
    const rows: ImageStatRow[] = [
      { bytes: 310 * MB, protected: true },
      { bytes: 10 * MB, protected: false },
    ];
    const s = summarizeStorage(rows, 700 * MB, 300 * MB);
    expect(s.protectedWarn).toBe(true);
    // ちょうど閾値は警告しない（超えた場合のみ）。
    expect(summarizeStorage([{ bytes: 300 * MB, protected: true }], 700 * MB, 300 * MB).protectedWarn).toBe(false);
  });
});

describe('formatBytes', () => {
  it('1000MB 未満は MB 表記', () => {
    expect(formatBytes(0)).toBe('0 MB');
    expect(formatBytes(1024 * 1024)).toBe('1.00 MB');
    expect(formatBytes(12.3 * 1024 * 1024)).toBe('12.3 MB');
  });
  it('1000MB 以上は GB 表記', () => {
    expect(formatBytes(1000 * 1024 * 1024)).toBe('0.98 GB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.00 GB');
  });
});

describe('summarizeOcrFailures', () => {
  it('issue_codes・display_mode 別に件数を集計し、多い順に並べる', () => {
    const rows: OcrFailureRow[] = [
      { issue_codes: ['display_mode_chips'], display_mode: 'chips' },
      { issue_codes: ['display_mode_chips', 'out_of_scope_raise'], display_mode: 'chips' },
      { issue_codes: ['seat_read_failed'], display_mode: 'bb' },
      { issue_codes: [], display_mode: null },
    ];
    const s = summarizeOcrFailures(rows);
    expect(s.total).toBe(4);
    expect(s.byIssueCode[0]).toEqual({ code: 'display_mode_chips', count: 2 });
    expect(s.byIssueCode).toContainEqual({ code: 'out_of_scope_raise', count: 1 });
    expect(s.byIssueCode).toContainEqual({ code: 'seat_read_failed', count: 1 });
    expect(s.byDisplayMode).toContainEqual({ mode: 'chips', count: 2 });
    expect(s.byDisplayMode).toContainEqual({ mode: 'bb', count: 1 });
    expect(s.byDisplayMode).toContainEqual({ mode: 'unknown', count: 1 });
  });

  it('topN で上位のみに絞る', () => {
    const rows: OcrFailureRow[] = [
      { issue_codes: ['a'], display_mode: 'bb' },
      { issue_codes: ['b'], display_mode: 'bb' },
      { issue_codes: ['c'], display_mode: 'bb' },
    ];
    expect(summarizeOcrFailures(rows, 2).byIssueCode).toHaveLength(2);
  });

  it('不正な形の issue_codes（配列でない）は無視する', () => {
    const rows: OcrFailureRow[] = [{ issue_codes: 'not-an-array', display_mode: 'bb' }];
    const s = summarizeOcrFailures(rows);
    expect(s.byIssueCode).toEqual([]);
  });
});

describe('displayModeLabelJa', () => {
  it('bb/chips/その他 のラベル', () => {
    expect(displayModeLabelJa('bb')).toBe('BB表示');
    expect(displayModeLabelJa('chips')).toBe('チップ表示');
    expect(displayModeLabelJa('unknown')).toBe('不明');
  });
});
