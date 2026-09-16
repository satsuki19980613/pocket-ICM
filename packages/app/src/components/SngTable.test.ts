/**
 * S&G の卓アダプタ（`SngTable.tsx`）のうち、席のアイコンを組み立てる `seatAvatarOf` のテスト。
 * さつき指示（アカウントアイコンの配線）: 画像があれば画像、無ければ名前の頭文字にフォールバック
 * すること、および PlayerState.avatarUrl が無い（undefined＝古い部屋の状態）を読んでも
 * 落ちずに null へ丸まることを固定する。
 * `deco`（アバター枠＋バッジ。avatarDeco.ts）は3引数目に渡すだけで、解決（resolveAvatarDeco）は
 * GlassTable.tsx 側の責務。ここでは「渡した値がそのまま avatar.deco に載る」ことだけ確認する。
 */
import { describe, it, expect } from 'vitest';

import { seatAvatarOf } from './SngTable';

describe('seatAvatarOf', () => {
  it('avatar_url がある席は src にそのまま渡す', () => {
    const av = seatAvatarOf('Satsuki', 'https://example.supabase.co/storage/v1/object/public/avatars/u/a.png');
    expect(av).toEqual({
      src: 'https://example.supabase.co/storage/v1/object/public/avatars/u/a.png',
      initial: 'S',
    });
  });

  it('avatar_url が null（未設定）なら src は null・initial は名前の頭文字', () => {
    expect(seatAvatarOf('Reiko', null)).toEqual({ src: null, initial: 'R' });
  });

  it('avatar_url が undefined（このフィールドが無い古い部屋の状態）でも落ちずに null に丸まる', () => {
    expect(seatAvatarOf('Jun', undefined)).toEqual({ src: null, initial: 'J' });
  });

  it('名前が空文字でも initial は "?" にフォールバックする（feedShared.tsx の Avatar と同じ流儀）', () => {
    expect(seatAvatarOf('', null)).toEqual({ src: null, initial: '?' });
  });

  it('名前が空白だけでも "?" にフォールバックする', () => {
    expect(seatAvatarOf('   ', null)).toEqual({ src: null, initial: '?' });
  });

  it('先頭が小文字の名前は大文字化した頭文字になる', () => {
    expect(seatAvatarOf('kenta', null)).toEqual({ src: null, initial: 'K' });
  });

  it('deco を渡すとそのまま avatar.deco に載る（3引数目・省略可）', () => {
    const deco = { frame_color: 'cyan', special_frame: null, badge: 'crab' };
    expect(seatAvatarOf('Satsuki', null, deco)).toEqual({ src: null, initial: 'S', deco });
  });

  it('deco を渡さなければ avatar.deco は undefined のまま（古い部屋の状態と同じ扱い）', () => {
    const av = seatAvatarOf('Satsuki', null);
    expect(av.deco).toBeUndefined();
  });
});
