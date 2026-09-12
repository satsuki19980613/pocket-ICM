import { describe, expect, it } from 'vitest';

import { buildTracks, labelFromFileName, resolveTrack } from './bgmTracks';

describe('labelFromFileName', () => {
  it('拡張子を外す', () => {
    expect(labelFromFileName('neon.mp3')).toBe('neon');
  });

  it('並び順の接頭辞（01- / 02_）は曲名から外す', () => {
    expect(labelFromFileName('01-neon-drive.mp3')).toBe('neon drive');
    expect(labelFromFileName('02_glitch_city.mp3')).toBe('glitch city');
    expect(labelFromFileName('10 - night.mp3')).toBe('night');
  });

  it('日本語のファイル名もそのまま曲名になる', () => {
    expect(labelFromFileName('01-夜の高速.mp3')).toBe('夜の高速');
  });

  it('数字で始まる曲名は消さない（区切りが無いものは接頭辞ではない）', () => {
    expect(labelFromFileName('2024年.mp3')).toBe('2024年');
  });

  it('接頭辞だけのファイル名は元の名前を見せる（空にしない）', () => {
    expect(labelFromFileName('01.mp3')).toBe('01');
  });
});

describe('buildTracks', () => {
  const map = {
    '../assets/bgm/02-second.mp3': '/assets/02-second-b2b2.mp3',
    '../assets/bgm/01-first.mp3': '/assets/01-first-a1a1.mp3',
  };

  it('ファイル名順に並べ、id はファイル名・src は配信 URL', () => {
    expect(buildTracks(map)).toEqual([
      { id: '01-first.mp3', label: 'first', src: '/assets/01-first-a1a1.mp3' },
      { id: '02-second.mp3', label: 'second', src: '/assets/02-second-b2b2.mp3' },
    ]);
  });

  it('1 曲も無ければ空', () => {
    expect(buildTracks({})).toEqual([]);
  });
});

describe('resolveTrack', () => {
  const tracks = buildTracks({
    '../assets/bgm/a.mp3': '/assets/a-1.mp3',
    '../assets/bgm/b.mp3': '/assets/b-2.mp3',
  });

  it('保存した id の曲を返す', () => {
    expect(resolveTrack(tracks, 'b.mp3')?.id).toBe('b.mp3');
  });

  it('未選択なら先頭', () => {
    expect(resolveTrack(tracks, null)?.id).toBe('a.mp3');
  });

  it('消した/名前を変えた曲の id でも先頭に落ちる（鳴らなくならない）', () => {
    expect(resolveTrack(tracks, 'gone.mp3')?.id).toBe('a.mp3');
  });

  it('曲が 1 つも無ければ null', () => {
    expect(resolveTrack([], 'a.mp3')).toBeNull();
  });
});
