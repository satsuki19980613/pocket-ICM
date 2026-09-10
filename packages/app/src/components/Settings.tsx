import { useEffect, useRef, useState } from 'react';
import {
  getMyProfile,
  updateDefaultPublic,
  changePassword,
  type MyProfile,
} from '../supabase/profile';
import { signOut, deleteAccount } from '../supabase/api';
import { uploadAvatar, removeAvatar } from '../supabase/avatar';
import { validatePassword } from '../auth/validate';
import { InfoMark, InfoModal } from './InfoModal';
import { useBackLayer } from './BackLayer';

/**
 * 設定画面（M7・モック s-profile 準拠）。表示名／パスワード変更・公開既定トグル・
 * ログアウト・アカウント削除。すべて RLS 下で本人のみ。
 * アイコンは端末内で正方形に切り出して 256px へ縮小・再圧縮してから `avatars` バケットへ上げる
 * （`supabase/avatar.ts`）。元の解像度のままは上げない。
 * ※ handle 変更（synthetic email 付け替え・Edge Function 要）は対象外＝読み取り専用。
 *   ログイン成功/削除後は App の onAuthStateChange がゲート（認証画面）へ戻す。
 */
export function Settings(props: { onBack: () => void; onOpenAdmin: () => void }): JSX.Element {
  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getMyProfile().then((r) => {
      if (!active) return;
      if (r.ok) setProfile(r.data);
      else setLoadErr(r.message);
    });
    return () => {
      active = false;
    };
  }, []);

  // パスワード変更
  const [editPw, setEditPw] = useState(false);
  const [pw1, setPw1] = useState('');
  const [pw2, setPw2] = useState('');
  const [pwErr, setPwErr] = useState<string | null>(null);
  const [pwBusy, setPwBusy] = useState(false);
  const [pwDone, setPwDone] = useState(false);

  // 公開既定トグル
  const [pubBusy, setPubBusy] = useState(false);

  // 削除
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);

  // 説明モーダル（保存・公開・削除まわりの注意書きをここへ畳む）
  const [showInfo, setShowInfo] = useState(false);

  function cancelPw(): void {
    setEditPw(false);
    setPw1('');
    setPw2('');
    setPwErr(null);
  }

  // 開いている入力・確認は、端末の戻る／Esc で「取消」相当にする（設定画面から出てしまわない）。
  useBackLayer(cancelPw, editPw);
  useBackLayer(() => setConfirmDelete(false), confirmDelete);

  // アイコン
  const avatarRef = useRef<HTMLInputElement>(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarErr, setAvatarErr] = useState<string | null>(null);

  async function onPickAvatar(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    e.target.value = ''; // 同じファイルを続けて選び直せるようにする。
    if (!file) return;
    setAvatarErr(null);
    setAvatarBusy(true);
    try {
      const r = await uploadAvatar(file);
      if (!r.ok) {
        setAvatarErr(r.message);
        return;
      }
      setProfile((prev) => (prev ? { ...prev, avatar_url: r.data.avatar_url } : prev));
    } finally {
      setAvatarBusy(false);
    }
  }

  async function onRemoveAvatar(): Promise<void> {
    setAvatarErr(null);
    setAvatarBusy(true);
    try {
      const r = await removeAvatar();
      if (!r.ok) {
        setAvatarErr(r.message);
        return;
      }
      setProfile((prev) => (prev ? { ...prev, avatar_url: null } : prev));
    } finally {
      setAvatarBusy(false);
    }
  }

  async function savePassword(): Promise<void> {
    setPwDone(false);
    const err = validatePassword(pw1);
    if (err) {
      setPwErr(err);
      return;
    }
    if (pw1 !== pw2) {
      setPwErr('確認用パスワードが一致しません');
      return;
    }
    setPwErr(null);
    setPwBusy(true);
    try {
      const r = await changePassword(pw1);
      if (!r.ok) {
        setPwErr(r.message);
        return;
      }
      setPw1('');
      setPw2('');
      setEditPw(false);
      setPwDone(true);
    } finally {
      setPwBusy(false);
    }
  }

  async function togglePublic(): Promise<void> {
    if (!profile) return;
    const next = !profile.default_public;
    setPubBusy(true);
    // 楽観更新 → 失敗なら戻す。
    setProfile({ ...profile, default_public: next });
    const r = await updateDefaultPublic(next);
    if (!r.ok) setProfile({ ...profile, default_public: !next });
    setPubBusy(false);
  }

  async function onLogout(): Promise<void> {
    setActionErr(null);
    setActionBusy(true);
    await signOut();
    // onAuthStateChange が session=null → 認証画面へ。
  }

  async function onDelete(): Promise<void> {
    setActionErr(null);
    setActionBusy(true);
    try {
      const r = await deleteAccount();
      if (!r.ok) {
        setActionErr(r.message);
        setActionBusy(false);
      }
      // 成功時は deleteAccount 内で signOut → onAuthStateChange がゲートへ。
    } catch {
      setActionErr('アカウントの削除に失敗しました');
      setActionBusy(false);
    }
  }

  const initial = (profile?.handle ?? '·').trim().charAt(0).toUpperCase() || '·';

  return (
    <div className="settings">
      <div className="avpick">
        <div className="avbig">
          {profile?.avatar_url ? <img src={profile.avatar_url} alt="" /> : initial}
        </div>
        <input ref={avatarRef} type="file" accept="image/*" hidden onChange={(e) => void onPickAvatar(e)} />
        <div className="avpick-actions">
          <button type="button" className="edit" disabled={!profile || avatarBusy} onClick={() => avatarRef.current?.click()}>
            {avatarBusy ? '変更中…' : profile?.avatar_url ? 'アイコンを変える' : 'アイコンを設定する'}
          </button>
          {profile?.avatar_url && (
            <button type="button" className="edit dim" disabled={avatarBusy} onClick={() => void onRemoveAvatar()}>
              削除
            </button>
          )}
        </div>
        {avatarErr && <p className="auth-err avpick-err">{avatarErr}</p>}
      </div>

      <div className="pad pt0 h-row">
        <InfoMark label="設定について" onClick={() => setShowInfo(true)} />
      </div>

      {loadErr && <p className="auth-err" style={{ margin: '12px 14px' }}>{loadErr}</p>}

      <div className="pad">
        <div className="readout">
          {/* ユーザー名（＝識別子。変更は準備中＝Edge Function 要） */}
          <div className="row">
            <span className="lb">ユーザー名</span>
            <span className="vl">@{profile?.handle ?? '—'}</span>
            <span className="edit dim" aria-disabled="true">
              準備中
            </span>
          </div>

          {/* パスワード */}
          <div className="row">
            <span className="lb">パスワード</span>
            {editPw ? (
              <span className="vl edit-inline">
                <input
                  className="inp"
                  type="password"
                  placeholder="新しいパスワード（8文字以上）"
                  autoComplete="new-password"
                  value={pw1}
                  onChange={(e) => setPw1(e.target.value)}
                />
                <input
                  className="inp"
                  type="password"
                  placeholder="確認のためもう一度"
                  autoComplete="new-password"
                  value={pw2}
                  onChange={(e) => setPw2(e.target.value)}
                />
                {pwErr && <em className="afield-err">{pwErr}</em>}
                <span className="edit-actions">
                  <button type="button" className="edit" disabled={pwBusy} onClick={() => void savePassword()}>
                    {pwBusy ? '変更中…' : '変更する'}
                  </button>
                  <button
                    type="button"
                    className="edit dim"
                    onClick={cancelPw}
                  >
                    取消
                  </button>
                </span>
              </span>
            ) : (
              <>
                <span className="vl">{pwDone ? '変更しました' : '••••••••••'}</span>
                <button
                  type="button"
                  className="edit"
                  onClick={() => {
                    setPwDone(false);
                    setEditPw(true);
                  }}
                >
                  変更
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="pad pt0">
        <h2 className="scr-h sm">公開のしかた</h2>
        <div className="readout">
          <div className="tog tog-pad">
            <div>計算したら最初から公開する</div>
            <button
              type="button"
              className="sw"
              role="switch"
              aria-checked={profile?.default_public ?? false}
              disabled={!profile || pubBusy}
              onClick={() => void togglePublic()}
            />
          </div>
        </div>
      </div>

      <div className="pad pt0">
        <h2 className="scr-h sm">アカウント</h2>
        {actionErr && <p className="auth-err">{actionErr}</p>}
        <div className="acct-actions">
          <button type="button" className="btn ghost" disabled={actionBusy} onClick={() => void onLogout()}>
            ログアウト
          </button>
          {confirmDelete ? (
            <div className="del-confirm">
              <p>本当に削除しますか？ 記録・公開したスレッド・画像もすべて消え、取り消せません。</p>
              <div className="del-row">
                <button type="button" className="btn red" disabled={actionBusy} onClick={() => void onDelete()}>
                  {actionBusy ? '削除中…' : '削除する'}
                </button>
                <button type="button" className="btn ghost" disabled={actionBusy} onClick={() => setConfirmDelete(false)}>
                  やめる
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="btn red" onClick={() => setConfirmDelete(true)}>
              アカウントを削除する
            </button>
          )}
        </div>
      </div>

      {profile?.is_admin && (
        <div className="pad pt0">
          <h2 className="scr-h sm">管理</h2>
          <button type="button" className="btn cyan" onClick={props.onOpenAdmin}>
            クラブ管理（招待キー・上限）
          </button>
        </div>
      )}

      <div className="pad pt0">
        <button type="button" className="btn ghost" onClick={props.onBack}>
          ← 計算に戻る
        </button>
      </div>

      {showInfo && (
        <InfoModal title="設定について" onClose={() => setShowInfo(false)}>
          <h3>公開のしかた</h3>
          {/* 日本語は JSX の改行が空白として入るため、1段落＝1行で書く。 */}
          <p>計算結果の公開はいつでも任意です。既定はオフで、切っておくと1件ずつ自分で公開を選べます。</p>
          <h3>保存について</h3>
          <p>計算した局面・結果・スクショ（端末内で圧縮した版）はサーバに保存されます。端末を変えてもログインすれば記録は残ります。</p>
          <h3>スクリーンショットの扱い</h3>
          <p>スクショは非公開です。見られるのは本人と管理者だけで、クラブの他のメンバーには見えません。</p>
          <p>OCR がうまく読めなかった画像は、読み取り精度を改善するために保持されます。そのため記録を削除しても、読めなかった画像だけはサーバに残る場合があります。</p>
          <h3>アカウントの削除</h3>
          <p>削除すると、記録・公開したスレッド・画像もすべて消えます。取り消せません。</p>
        </InfoModal>
      )}
    </div>
  );
}
