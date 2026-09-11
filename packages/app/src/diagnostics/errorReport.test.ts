import { describe, expect, it } from 'vitest';
import {
  clip,
  createReportGate,
  describeError,
  isNoise,
  joinDetail,
  reportKey,
  DETAIL_MAX,
  MESSAGE_MAX,
} from './errorReport';

describe('describeError', () => {
  it('Error は文面とスタック', () => {
    const d = describeError(new Error('boom'));
    expect(d.message).toBe('boom');
    expect(d.detail).toContain('boom');
  });

  it('Error 以外の種類は名前を前に付ける', () => {
    expect(describeError(new TypeError('x is not a function')).message).toBe('TypeError: x is not a function');
  });

  it('文面の無い Error は名前だけ', () => {
    expect(describeError(new RangeError('')).message).toBe('RangeError');
  });

  it('文字列はそのまま・空なら目印を入れる（サーバの CHECK は1文字以上）', () => {
    expect(describeError('失敗').message).toBe('失敗');
    expect(describeError('').message).toBe('(空のエラー)');
    expect(describeError('失敗').detail).toBeNull();
  });

  it('message を持つオブジェクト（Supabase のエラー等）は message と中身全体', () => {
    const d = describeError({ message: 'permission denied', code: '42501' });
    expect(d.message).toBe('permission denied');
    expect(d.detail).toContain('42501');
  });

  it('それ以外は JSON（undefined・null も文字にする）', () => {
    expect(describeError({ a: 1 }).message).toBe('{"a":1}');
    expect(describeError(undefined).message).toBe('undefined');
    expect(describeError(null).message).toBe('null');
  });

  it('循環したオブジェクトでも落ちない', () => {
    const o: Record<string, unknown> = {};
    o.self = o;
    expect(describeError(o).message).toBe('[object Object]');
  });

  it('長すぎる文面・詳細はサーバの上限に切り詰める', () => {
    const d = describeError('x'.repeat(MESSAGE_MAX + 50));
    expect(d.message).toHaveLength(MESSAGE_MAX);
    expect(d.message.endsWith('…')).toBe(true);
    const e = new Error('y');
    e.stack = 'z'.repeat(DETAIL_MAX + 10);
    expect(describeError(e).detail).toHaveLength(DETAIL_MAX);
  });
});

describe('clip', () => {
  it('上限以内はそのまま・超えたら … を含めて上限の長さ', () => {
    expect(clip('abc', 3)).toBe('abc');
    expect(clip('abcd', 3)).toBe('ab…');
  });
});

describe('isNoise', () => {
  it('ブラウザの無害な警告・中身の伏せられたエラーは送らない', () => {
    expect(isNoise({ message: 'ResizeObserver loop completed with undelivered notifications.', detail: null })).toBe(true);
    expect(isNoise({ message: 'Script error.', detail: null })).toBe(true);
  });

  it('拡張機能のスクリプトから出たエラーは送らない', () => {
    expect(isNoise({ message: 'x', detail: 'at foo (chrome-extension://abc/content.js:1:2)' })).toBe(true);
    expect(isNoise({ message: 'x', detail: 'at foo (safari-web-extension://abc/c.js:1:2)' })).toBe(true);
  });

  it('アプリのエラーは送る', () => {
    expect(isNoise({ message: 'TypeError: cannot read properties of undefined', detail: 'at App (index-abc.js:1:2)' })).toBe(false);
  });
});

describe('createReportGate', () => {
  it('同じエラーは1回だけ通す', () => {
    const g = createReportGate(5);
    const k = reportKey('render', 'boom');
    expect(g.admit(k)).toBe(true);
    expect(g.admit(k)).toBe(false);
  });

  it('種類が違えば別のエラーとして数える', () => {
    const g = createReportGate(5);
    expect(g.admit(reportKey('render', 'boom'))).toBe(true);
    expect(g.admit(reportKey('error', 'boom'))).toBe(true);
  });

  it('合計が上限に達したら以後は通さない', () => {
    const g = createReportGate(2);
    expect(g.admit('a')).toBe(true);
    expect(g.admit('b')).toBe(true);
    expect(g.admit('c')).toBe(false);
  });
});

describe('joinDetail', () => {
  it('空・null を飛ばしてつなぐ', () => {
    expect(joinDetail('stack', null, '', '  ', 'where')).toBe('stack\n---\nwhere');
  });

  it('何も無ければ null', () => {
    expect(joinDetail(null, undefined, '')).toBeNull();
  });

  it('つないだ結果もサーバの上限に切り詰める', () => {
    expect(joinDetail('a'.repeat(DETAIL_MAX), 'b')).toHaveLength(DETAIL_MAX);
  });
});
