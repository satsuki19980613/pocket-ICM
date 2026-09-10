import { describe, it, expect } from 'vitest';
import { AVATAR_EDGE, avatarFileName, avatarOutputEdge, squareCropRect, withCacheBuster } from './avatar';

describe('squareCropRect', () => {
  it('正方形はそのまま（切り出し無し）', () => {
    expect(squareCropRect(500, 500)).toEqual({ sx: 0, sy: 0, size: 500 });
  });

  it('横長は左右を均等に落として中央の正方形にする', () => {
    // 1000x400 → 一辺400、左右に (1000-400)/2 = 300 ずつ余る。
    expect(squareCropRect(1000, 400)).toEqual({ sx: 300, sy: 0, size: 400 });
  });

  it('縦長は上下を均等に落として中央の正方形にする', () => {
    // 400x1000 → 一辺400、上下に 300 ずつ余る。
    expect(squareCropRect(400, 1000)).toEqual({ sx: 0, sy: 300, size: 400 });
  });

  it('奇数差でも中央に寄せる（切り捨てず四捨五入）', () => {
    expect(squareCropRect(101, 100)).toEqual({ sx: 1, sy: 0, size: 100 });
  });

  it('0 でも 1px を返す（Canvas が幅0で落ちないように）', () => {
    expect(squareCropRect(0, 0).size).toBe(1);
  });
});

describe('avatarOutputEdge', () => {
  it('大きい画像は上限（256px）まで縮める', () => {
    expect(avatarOutputEdge(4000)).toBe(AVATAR_EDGE);
    expect(avatarOutputEdge(257)).toBe(AVATAR_EDGE);
  });

  it('上限より小さい画像は拡大しない（ぼやけるだけで容量が増えるため）', () => {
    expect(avatarOutputEdge(120)).toBe(120);
    expect(avatarOutputEdge(256)).toBe(256);
  });
});

describe('avatarFileName', () => {
  it('WebP と JPEG でパスを分ける（どちらか一方だけを残す）', () => {
    expect(avatarFileName('image/webp')).toBe('avatar.webp');
    expect(avatarFileName('image/jpeg')).toBe('avatar.jpg');
  });
});

describe('withCacheBuster', () => {
  it('パス固定で上書きするので ?v= で古い画像を掴ませない', () => {
    expect(withCacheBuster('https://x/storage/avatars/u/avatar.webp', 123)).toBe(
      'https://x/storage/avatars/u/avatar.webp?v=123',
    );
  });

  it('既にクエリがあれば & でつなぐ', () => {
    expect(withCacheBuster('https://x/a.webp?token=1', 9)).toBe('https://x/a.webp?token=1&v=9');
  });
});
