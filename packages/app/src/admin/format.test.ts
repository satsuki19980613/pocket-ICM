import { describe, it, expect } from 'vitest';
import { seatsRemaining, isExpired, effectiveStatus, canRevoke, statusLabelJa } from './format';

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
