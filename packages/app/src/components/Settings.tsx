import { useEffect, useState } from 'react';
import {
  getMyProfile,
  updateDisplayName,
  updateDefaultPublic,
  changePassword,
  type MyProfile,
} from '../supabase/profile';
import { signOut, deleteAccount } from '../supabase/api';
import { validateDisplayName, validatePassword } from '../auth/validate';

/**
 * 設定画面（M7・モック s-profile 準拠）。表示名／パスワード変更・公開既定トグル・
 * ログアウト・アカウント削除。すべて RLS 下で本人のみ。
 * ※ handle 変更（synthetic email 付け替え・Edge Function 要）と avatar アップロード（Storage）は
 *   本セッションでは対象外＝読み取り専用／準備中表示。ログイン成功/削除後は App の
 *   onAuthStateChange がゲート（認証画面）へ戻す。
 */
export function Settings(props: { onBack: () => void }): JSX.Element {
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

  // 表示名編集
  const [editName, setEditName] = useState(false);
  const [nameVal, setNameVal] = useState('');
  const [nameErr, setNameErr] = useState<string | null>(null);
  const [nameBusy, setNameBusy] = useState(false);

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

  function startEditName(): void {
    setNameVal(profile?.display_name ?? '');
    setNameErr(null);
    setEditName(true);
  }

  async function saveName(): Promise<void> {
    const err = validateDisplayName(nameVal);
    setNameErr(err);
    if (err) return;
    setNameBusy(true);
    try {
      const r = await updateDisplayName(nameVal);
      if (!r.ok) {
        setNameErr(r.message);
        return;
      }
      setProfile((p) => (p ? { ...p, display_name: r.data.display_name } : p));
      setEditName(false);
    } finally {
      setNameBusy(false);
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

  const initial = (profile?.display_name ?? '·').trim().charAt(0) || '·';

  return (
    <div className="settings">
      <div className="avpick">
        <div className="avbig">{initial}</div>
        <div className="lbl dim">アイコン変更は準備中</div>
      </div>

      {loadErr && <p className="auth-err" style={{ margin: '12px 14px' }}>{loadErr}</p>}

      <div className="pad">
        <div className="readout">
          {/* 表示名 */}
          <div className="row">
            <span className="lb">表示名</span>
            {editName ? (
              <span className="vl edit-inline">
                <input
                  className="inp"
                  type="text"
                  value={nameVal}
                  maxLength={40}
                  autoFocus
                  onChange={(e) => setNameVal(e.target.value)}
                />
                {nameErr && <em className="afield-err">{nameErr}</em>}
                <span className="edit-actions">
                  <button type="button" className="edit" disabled={nameBusy} onClick={() => void saveName()}>
                    {nameBusy ? '保存中…' : '保存'}
                  </button>
                  <button type="button" className="edit dim" onClick={() => setEditName(false)}>
                    取消
                  </button>
                </span>
              </span>
            ) : (
              <>
                <span className="vl">{profile?.display_name ?? '—'}</span>
                <button type="button" className="edit" disabled={!profile} onClick={startEditName}>
                  変更
                </button>
              </>
            )}
          </div>

          {/* ユーザー名（変更は準備中＝Edge Function 要） */}
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
                    onClick={() => {
                      setEditPw(false);
                      setPw1('');
                      setPw2('');
                      setPwErr(null);
                    }}
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
            <div>
              計算したら最初から公開する
              <small>切っておくと、1件ずつ自分で公開を選べます</small>
            </div>
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
        <p className="note">※ 公開設定はホーム（スレッド）実装後に反映されます。</p>
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
        <p className="note">削除すると、記録・公開したスレッド・画像もすべて消えます。取り消せません。</p>
      </div>

      <div className="pad pt0">
        <button type="button" className="btn ghost" onClick={props.onBack}>
          ← 計算に戻る
        </button>
      </div>
    </div>
  );
}
