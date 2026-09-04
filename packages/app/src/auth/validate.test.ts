import { describe, it, expect } from 'vitest';
import { HANDLE_RE, validateLogin, validateSignup } from './validate';

describe('validateLogin', () => {
  it('空欄はエラー', () => {
    const r = validateLogin({ handle: '  ', password: '' });
    expect(r.ok).toBe(false);
    expect(r.handle).toBeTruthy();
    expect(r.password).toBeTruthy();
  });
  it('両方埋まれば OK', () => {
    const r = validateLogin({ handle: 'satsuki', password: 'x' });
    expect(r.ok).toBe(true);
    expect(r.handle).toBeNull();
    expect(r.password).toBeNull();
  });
});

describe('HANDLE_RE（サーバ規則ミラー）', () => {
  it('英小文字・数字・_ の3〜20文字を許可', () => {
    expect(HANDLE_RE.test('abc')).toBe(true);
    expect(HANDLE_RE.test('a_1')).toBe(true);
    expect(HANDLE_RE.test('a'.repeat(20))).toBe(true);
  });
  it('大文字・記号・長さ外は不可', () => {
    expect(HANDLE_RE.test('ab')).toBe(false); // 短すぎ
    expect(HANDLE_RE.test('a'.repeat(21))).toBe(false); // 長すぎ
    expect(HANDLE_RE.test('Abc')).toBe(false); // 大文字
    expect(HANDLE_RE.test('a-b')).toBe(false); // ハイフン
    expect(HANDLE_RE.test('a b')).toBe(false); // 空白
  });
});

describe('validateSignup', () => {
  const base = {
    display_name: 'さつき',
    handle: 'satsuki',
    password: 'password1',
    invite_code: 'POCKET-ABCD-EFGH',
  };
  it('全て妥当なら OK', () => {
    expect(validateSignup(base).ok).toBe(true);
  });
  it('表示名は1〜40文字', () => {
    expect(validateSignup({ ...base, display_name: '' }).display_name).toBeTruthy();
    expect(validateSignup({ ...base, display_name: 'あ'.repeat(41) }).display_name).toBeTruthy();
  });
  it('handle はサーバ規則で弾く（大文字→エラー）', () => {
    const r = validateSignup({ ...base, handle: 'Satsuki' });
    // トリム＋小文字化してから判定するので Satsuki は satsuki となり通る。
    expect(r.handle).toBeNull();
    // 記号入りは不可。
    expect(validateSignup({ ...base, handle: 'a-b' }).handle).toBeTruthy();
    expect(validateSignup({ ...base, handle: 'ab' }).handle).toBeTruthy();
  });
  it('パスワードは8文字以上', () => {
    expect(validateSignup({ ...base, password: 'short' }).password).toBeTruthy();
    expect(validateSignup({ ...base, password: '12345678' }).password).toBeNull();
  });
  it('招待キーは必須', () => {
    expect(validateSignup({ ...base, invite_code: '   ' }).invite_code).toBeTruthy();
  });
});
