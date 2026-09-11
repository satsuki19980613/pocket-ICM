import { describe, expect, it } from 'vitest';

import {
  findOrphans,
  listAllObjects,
  pathFromRef,
  referencedPathFromRef,
  removeUserFiles,
  type StorageLike,
  type StoredObject,
} from './userFiles';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const F = (n: number): string => `${String(n).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa.webp`;

/** バケット → パス一覧 を持つ偽の Storage。list はフォルダ（id=null）とファイルを返し分ける。 */
function fakeStorage(files: Record<string, string[]>, opts: { failList?: string; failRemove?: string } = {}) {
  const removed: Record<string, string[]> = {};
  const storage: StorageLike = {
    from(bucket) {
      return {
        async list(prefix, { limit, offset }) {
          if (opts.failList === bucket) return { data: null, error: { message: 'boom' } };
          const all = files[bucket] ?? [];
          let entries: { name: string; id: string | null; created_at: string | null }[];
          if (prefix === '') {
            const folders = [...new Set(all.map((p) => p.split('/')[0] ?? ''))];
            entries = folders.map((f) => ({ name: f, id: null, created_at: null }));
          } else {
            entries = all
              .filter((p) => p.startsWith(`${prefix}/`))
              .map((p) => ({
                name: p.slice(prefix.length + 1),
                id: `id-${p}`,
                created_at: '2026-01-01T00:00:00Z',
                metadata: { size: 1234 },
              }));
          }
          return { data: entries.slice(offset, offset + limit), error: null };
        },
        async remove(paths) {
          if (opts.failRemove === bucket) return { data: null, error: { message: 'nope' } };
          (removed[bucket] ??= []).push(...paths);
          files[bucket] = (files[bucket] ?? []).filter((p) => !paths.includes(p));
          return { data: paths, error: null };
        },
      };
    },
  };
  return { storage, removed };
}

describe('removeUserFiles（アカウント削除時にファイル本体を消す）', () => {
  it('その人のフォルダのファイルだけを、3つのバケットすべてから消す', async () => {
    const { storage, removed } = fakeStorage({
      'spot-images': [`${U1}/${F(1)}`, `${U2}/${F(2)}`],
      'thread-images': [`${U1}/${F(3)}`],
      avatars: [`${U1}/${F(4)}`, `${U2}/${F(5)}`],
    });
    const r = await removeUserFiles(storage, U1);
    expect(r).toEqual({ removed: 3 });
    expect(removed['spot-images']).toEqual([`${U1}/${F(1)}`]);
    expect(removed['thread-images']).toEqual([`${U1}/${F(3)}`]);
    expect(removed.avatars).toEqual([`${U1}/${F(4)}`]);
  });

  it('100件を超えても取りこぼさない（列挙してから消す）', async () => {
    const many = Array.from({ length: 250 }, (_, i) => `${U1}/${F(i)}`);
    const { storage, removed } = fakeStorage({ 'spot-images': [...many] });
    const r = await removeUserFiles(storage, U1);
    expect(r).toEqual({ removed: 250 });
    expect(new Set(removed['spot-images'])).toEqual(new Set(many));
  });

  it('uid が UUID でなければ何も消さない（別の人のフォルダやバケット全体を消す事故を防ぐ）', async () => {
    const { storage, removed } = fakeStorage({ 'spot-images': [`${U1}/${F(1)}`] });
    expect(await removeUserFiles(storage, '')).toHaveProperty('error');
    expect(await removeUserFiles(storage, '../x')).toHaveProperty('error');
    expect(removed).toEqual({});
  });

  it('列挙・削除に失敗したらエラーを返す（呼び出し側はアカウントを消さない）', async () => {
    const a = fakeStorage({ avatars: [`${U1}/${F(1)}`] }, { failList: 'thread-images' });
    expect(await removeUserFiles(a.storage, U1)).toHaveProperty('error');
    const b = fakeStorage({ avatars: [`${U1}/${F(1)}`] }, { failRemove: 'avatars' });
    expect(await removeUserFiles(b.storage, U1)).toHaveProperty('error');
  });
});

describe('listAllObjects（孤児回収のためにバケット全体を列挙）', () => {
  it('全員のフォルダを辿ってファイルを返す（大きさ・作成時刻は Storage の値）', async () => {
    const { storage } = fakeStorage({ avatars: [`${U1}/${F(1)}`, `${U2}/${F(2)}`, `${U2}/${F(3)}`] });
    const r = await listAllObjects(storage, 'avatars');
    expect('objects' in r && r.objects.map((o) => o.path).sort()).toEqual(
      [`${U1}/${F(1)}`, `${U2}/${F(2)}`, `${U2}/${F(3)}`].sort(),
    );
    expect('objects' in r && r.objects.every((o) => o.size === 1234 && o.createdAt === '2026-01-01T00:00:00Z')).toBe(
      true,
    );
  });
});

describe('pathFromRef（DB の画像参照 → バケット内のパス）', () => {
  const base = 'https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public';
  it('正しい形ならパスを返す', () => {
    expect(pathFromRef(`${base}/thread-images/${U1}/${F(1)}`, 'thread-images')).toBe(`${U1}/${F(1)}`);
    expect(pathFromRef(`${base}/avatars/${U1}/${F(1)}`, 'avatars')).toBe(`${U1}/${F(1)}`);
  });
  it('別バケット・余計な階層・形の違うファイル名・空は null', () => {
    expect(pathFromRef(`${base}/avatars/${U1}/${F(1)}`, 'thread-images')).toBeNull();
    expect(pathFromRef(`${base}/thread-images/${U1}/x/${F(1)}`, 'thread-images')).toBeNull();
    expect(pathFromRef(`${base}/thread-images/${U1}/evil.svg`, 'thread-images')).toBeNull();
    expect(pathFromRef(`${base}/thread-images/../${F(1)}`, 'thread-images')).toBeNull();
    expect(pathFromRef(null, 'thread-images')).toBeNull();
    expect(pathFromRef('javascript:alert(1)', 'thread-images')).toBeNull();
  });
});

describe('referencedPathFromRef（孤児判定では形の違う古い参照も「参照中」として守る）', () => {
  const base = 'https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public';
  it('クエリを落としてパスを返す（形は問わない）', () => {
    expect(referencedPathFromRef(`${base}/thread-images/${U1}/${F(1)}?t=1`, 'thread-images')).toBe(`${U1}/${F(1)}`);
    expect(referencedPathFromRef(`${base}/avatars/${U1}/old-name.jpeg`, 'avatars')).toBe(`${U1}/old-name.jpeg`);
    expect(referencedPathFromRef(`${base}/avatars/${U1}/a%20b.png`, 'avatars')).toBe(`${U1}/a b.png`);
  });
  it('別バケット・空は null', () => {
    expect(referencedPathFromRef(`${base}/avatars/${U1}/${F(1)}`, 'thread-images')).toBeNull();
    expect(referencedPathFromRef(null, 'avatars')).toBeNull();
  });
});

describe('findOrphans（どこからも参照されていない古いファイル）', () => {
  const now = Date.parse('2026-09-11T00:00:00Z');
  const day = 24 * 3600_000;
  const objs: StoredObject[] = [
    { path: 'a', createdAt: '2026-09-01T00:00:00Z', size: 1 }, // 古い・未参照 → 孤児
    { path: 'b', createdAt: '2026-09-01T00:00:00Z', size: 1 }, // 古いが参照あり → 残す
    { path: 'c', createdAt: '2026-09-10T23:00:00Z', size: 1 }, // 1時間前（アップロード直後の可能性）→ 残す
    { path: 'd', createdAt: null, size: 1 }, // 作成時刻不明 → 安全側で残す
  ];
  it('参照されていて・新しくて・時刻不明のものは消さない', () => {
    expect(findOrphans(objs, new Set(['b']), now, day)).toEqual(['a']);
  });
});
