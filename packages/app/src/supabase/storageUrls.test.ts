import { describe, expect, it } from 'vitest';

import { createSignedUrlResolver, SIGN_TTL_SEC, storagePathFromRef, type Signer } from './storageUrls';

const BASE = 'https://abcdefghijklmnopqrst.supabase.co';
const U1 = '11111111-1111-4111-8111-111111111111';
const FILE = '0f0f0f0f-aaaa-4bbb-8ccc-dddddddddddd.webp';
const REF = `${BASE}/storage/v1/object/public/thread-images/${U1}/${FILE}`;

describe('storagePathFromRef（DB の画像参照を表示してよいかの判定）', () => {
  it('このアプリの Storage の、規約どおりの参照ならパスを返す', () => {
    expect(storagePathFromRef(REF, 'thread-images', BASE)).toBe(`${U1}/${FILE}`);
    expect(storagePathFromRef(REF.replace('thread-images', 'avatars'), 'avatars', BASE)).toBe(`${U1}/${FILE}`);
    // 末尾スラッシュ付きの設定値でも同じ
    expect(storagePathFromRef(REF, 'thread-images', `${BASE}/`)).toBe(`${U1}/${FILE}`);
  });

  it('javascript: / data: / 外部サイト / 別プロジェクトは表示しない', () => {
    for (const bad of [
      'javascript:alert(document.cookie)',
      'JAVASCRIPT:alert(1)',
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      `https://evil.example.com/storage/v1/object/public/thread-images/${U1}/${FILE}`,
      `https://zzzzzzzzzzzzzzzzzzzz.supabase.co/storage/v1/object/public/thread-images/${U1}/${FILE}`,
      `http://abcdefghijklmnopqrst.supabase.co/storage/v1/object/public/thread-images/${U1}/${FILE}`,
      `${BASE}.evil.com/storage/v1/object/public/thread-images/${U1}/${FILE}`,
    ]) {
      expect(storagePathFromRef(bad, 'thread-images', BASE), bad).toBeNull();
    }
  });

  it('バケット違い・余計な階層・パス遡り・クエリ・形の違うファイル名は表示しない', () => {
    const p = `${BASE}/storage/v1/object/public/thread-images/`;
    for (const bad of [
      REF.replace('thread-images', 'avatars'), // avatars の参照を thread-images として
      `${p}${U1}/sub/${FILE}`,
      `${p}${U1}/../${FILE}`,
      `${p}${U1}/${FILE}?download=1`,
      `${p}${U1}/${FILE}#x`,
      `${p}${U1}/${FILE.replace('.webp', '.svg')}`,
      `${p}${U1}/${FILE.replace('.webp', '.html')}`,
      // 大文字の UUID（U1 は数字だけで大文字化しても変わらないので、英字を含む uid で試す）
      `${p}ABCDEF01-2345-4678-89AB-CDEF01234567/${FILE}`,
      `${p}${U1}/${FILE.toUpperCase()}`,
      `${p}${FILE}`,
      `${p}${U1}/${FILE}/`,
    ]) {
      expect(storagePathFromRef(bad, 'thread-images', BASE), bad).toBeNull();
    }
  });

  it('アイコンだけは、初期の版が保存した avatar.(webp|jpg)?v=<数字> の形も認める', () => {
    const a = `${BASE}/storage/v1/object/public/avatars/${U1}`;
    expect(storagePathFromRef(`${a}/avatar.webp?v=1757000000000`, 'avatars', BASE)).toBe(`${U1}/avatar.webp`);
    expect(storagePathFromRef(`${a}/avatar.jpg`, 'avatars', BASE)).toBe(`${U1}/avatar.jpg`);
    // スレッド画像では認めない・形の違うクエリや拡張子は認めない
    expect(
      storagePathFromRef(`${BASE}/storage/v1/object/public/thread-images/${U1}/avatar.webp`, 'thread-images', BASE),
    ).toBeNull();
    expect(storagePathFromRef(`${a}/avatar.webp?v=abc`, 'avatars', BASE)).toBeNull();
    expect(storagePathFromRef(`${a}/avatar.svg?v=1`, 'avatars', BASE)).toBeNull();
    expect(storagePathFromRef(`${a}/avatar.webp?v=1&x=2`, 'avatars', BASE)).toBeNull();
  });

  it('空・null・設定なしは表示しない', () => {
    expect(storagePathFromRef(null, 'thread-images', BASE)).toBeNull();
    expect(storagePathFromRef('', 'thread-images', BASE)).toBeNull();
    expect(storagePathFromRef(REF, 'thread-images', '')).toBeNull();
  });
});

describe('createSignedUrlResolver（署名 URL をまとめて取り、期限まで使い回す）', () => {
  function setup(signerImpl?: Signer) {
    let t = 1_000_000;
    const tasks: (() => void)[] = [];
    const calls: { bucket: string; paths: string[] }[] = [];
    const signer: Signer =
      signerImpl ??
      (async (bucket, paths) => {
        calls.push({ bucket, paths: [...paths] });
        return new Map(paths.map((p) => [p, `${BASE}/storage/v1/object/sign/${bucket}/${p}?token=t${calls.length}`]));
      });
    const r = createSignedUrlResolver({ signer, base: BASE, now: () => t, schedule: (fn) => tasks.push(fn) });
    const run = async (): Promise<void> => {
      while (tasks.length) tasks.shift()?.();
      await new Promise((res) => setTimeout(res, 0));
    };
    return { r, calls, run, advance: (ms: number) => (t += ms) };
  }

  it('同じ描画で要る分は1回の署名にまとめ、同じパスの重複要求も1つにする', async () => {
    const { r, calls, run } = setup();
    const a = r.get('thread-images', 'p1');
    const b = r.get('thread-images', 'p2');
    const a2 = r.get('thread-images', 'p1');
    await run();
    expect(await a).toContain('/object/sign/thread-images/p1');
    expect(await b).toContain('/object/sign/thread-images/p2');
    expect(await a2).toBe(await a);
    expect(calls).toEqual([{ bucket: 'thread-images', paths: ['p1', 'p2'] }]);
  });

  it('期限内はキャッシュを使い、期限が近づいたら取り直す', async () => {
    const { r, calls, run, advance } = setup();
    const first = r.get('avatars', 'p');
    await run();
    expect(r.peek('avatars', 'p')).toBe(await first);
    await r.get('avatars', 'p');
    expect(calls.length).toBe(1);
    advance(SIGN_TTL_SEC * 1000); // 期限切れ
    expect(r.peek('avatars', 'p')).toBeNull();
    const again = r.get('avatars', 'p');
    await run();
    await again;
    expect(calls.length).toBe(2);
  });

  it('取り直しに失敗したときは、表示中の署名 URL を使い続ける（壊れた公開 URL に替えない）', async () => {
    let fail = false;
    let n = 0;
    const { r, run, advance } = setup(async (bucket, paths) => {
      n += 1;
      if (fail) throw new Error('offline');
      return new Map(paths.map((p) => [p, `${BASE}/storage/v1/object/sign/${bucket}/${p}?token=${n}`]));
    });
    const first = r.get('avatars', `${U1}/${FILE}`);
    await run();
    const signedUrl = await first;
    expect(signedUrl).toContain('/object/sign/');
    fail = true;
    advance(SIGN_TTL_SEC * 1000); // 期限切れ → 取り直し（失敗）
    const again = r.get('avatars', `${U1}/${FILE}`);
    await run();
    expect(await again).toBe(signedUrl);
  });

  it('署名できなければ公開 URL 形式に落とし（移行期間用）、しばらくして取り直す', async () => {
    let n = 0;
    const { r, run, advance } = setup(async () => {
      n += 1;
      throw new Error('no policy yet');
    });
    const u = r.get('thread-images', `${U1}/${FILE}`);
    await run();
    expect(await u).toBe(REF);
    await r.get('thread-images', `${U1}/${FILE}`);
    expect(n).toBe(1); // 直後はキャッシュ
    advance(2 * 60_000);
    const again = r.get('thread-images', `${U1}/${FILE}`);
    await run();
    await again;
    expect(n).toBe(2);
  });
});
