import { describe, it, expect } from 'vitest';

import { isValidHex, resolveAvatarDeco, specialVars } from './avatarDeco';

describe('isValidHex', () => {
  it('小文字の #rrggbb を受け付ける', () => {
    expect(isValidHex('#f5c542')).toBe(true);
  });
  it('大文字・短縮形・#無しは弾く', () => {
    expect(isValidHex('#F5C542')).toBe(false);
    expect(isValidHex('#fff')).toBe(false);
    expect(isValidHex('f5c542')).toBe(false);
    expect(isValidHex('')).toBe(false);
  });
});

describe('specialVars', () => {
  it('付与色から --sp 系を算出する（retune 後の係数: 白へ35%寄せ・60%へ落とす・glow 0.28）', () => {
    const v = specialVars('#f5c542');
    expect(v['--sp']).toBe('#f5c542');
    // r=245,g=197,b=66 → hi は白へ35%寄せ、lo は60%へ落とす、glow はそのままの rgba(...,0.28)。
    expect(v['--sp-hi']).toBe('rgb(249,217,132)');
    expect(v['--sp-lo']).toBe('rgb(147,118,40)');
    expect(v['--sp-glow']).toBe('rgba(245,197,66,0.28)');
  });
});

describe('resolveAvatarDeco', () => {
  it('既定（frame_color 無し）は steel・バッジ無し', () => {
    expect(resolveAvatarDeco(null)).toEqual({ ringClass: 'ring-steel', ringStyle: undefined, badge: null });
    expect(resolveAvatarDeco(undefined)).toEqual({ ringClass: 'ring-steel', ringStyle: undefined, badge: null });
    expect(resolveAvatarDeco({})).toEqual({ ringClass: 'ring-steel', ringStyle: undefined, badge: null });
  });

  it('通常色6色はそのまま ring-<色> になる', () => {
    for (const c of ['steel', 'yellow', 'cyan', 'red', 'white', 'purple']) {
      expect(resolveAvatarDeco({ frame_color: c })).toEqual({ ringClass: `ring-${c}`, ringStyle: undefined, badge: null });
    }
  });

  it('未知の frame_color は steel に丸める（防御）', () => {
    expect(resolveAvatarDeco({ frame_color: 'rainbow' })).toEqual({ ringClass: 'ring-steel', ringStyle: undefined, badge: null });
  });

  it('special + prism は ring-special ring-prism（style 無し・静的 CSS で描く）', () => {
    expect(resolveAvatarDeco({ frame_color: 'special', special_frame: 'prism' })).toEqual({
      ringClass: 'ring-special ring-prism',
      ringStyle: undefined,
      badge: null,
    });
  });

  it('special + 有効な hex は ring-special と --sp 系の style を持つ', () => {
    const deco = resolveAvatarDeco({ frame_color: 'special', special_frame: '#ff5fd2' });
    expect(deco.ringClass).toBe('ring-special');
    expect(deco.ringStyle).toBeDefined();
    expect(deco.ringStyle?.['--sp']).toBe('#ff5fd2');
  });

  it('special なのに special_frame が無い/不正なら steel に丸める（付与前の事故防止）', () => {
    expect(resolveAvatarDeco({ frame_color: 'special', special_frame: null })).toEqual({
      ringClass: 'ring-steel',
      ringStyle: undefined,
      badge: null,
    });
    expect(resolveAvatarDeco({ frame_color: 'special', special_frame: 'gold' })).toEqual({
      ringClass: 'ring-steel',
      ringStyle: undefined,
      badge: null,
    });
    expect(resolveAvatarDeco({ frame_color: 'special', special_frame: '#FF5FD2' })).toEqual({
      ringClass: 'ring-steel',
      ringStyle: undefined,
      badge: null,
    });
  });

  it('badge は crab のみ通し、未知/欠損は null', () => {
    expect(resolveAvatarDeco({ badge: 'crab' }).badge).toBe('crab');
    expect(resolveAvatarDeco({ badge: 'dragon' }).badge).toBeNull();
    expect(resolveAvatarDeco({ badge: null }).badge).toBeNull();
    expect(resolveAvatarDeco({}).badge).toBeNull();
  });

  it('frame_color と badge は独立に解決する（special が崩れても badge は生きる）', () => {
    const deco = resolveAvatarDeco({ frame_color: 'special', special_frame: null, badge: 'crab' });
    expect(deco.ringClass).toBe('ring-steel');
    expect(deco.badge).toBe('crab');
  });
});
