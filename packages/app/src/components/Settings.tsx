import { useEffect, useRef, useState } from 'react';
import {
  getMyProfile,
  updateDefaultPublic,
  updateFrameColor,
  changePassword,
  type MyProfile,
} from '../supabase/profile';
import { signOut, deleteAccount } from '../supabase/api';
import { uploadAvatar, removeAvatar } from '../supabase/avatar';
import { validatePassword } from '../auth/validate';
import { checkForUpdate, useAppUpdate, type UpdatePhase } from '../pwa/appUpdate';
import { useStorageImage } from '../supabase/storageUrls';
import { InfoMark, InfoModal } from './InfoModal';
import { useBackLayer } from './BackLayer';
import {
  AvatarBadge,
  NORMAL_FRAME_COLORS,
  resolveAvatarDeco,
  specialVars,
  type FrameColor,
  type NormalFrameColor,
} from '../avatarDeco';

/** 通常6色の表示名（AI感の強いネオン配色という指摘を受けた retune で、色に合わせて改名）。 */
function frameColorLabel(c: NormalFrameColor): string {
  switch (c) {
    case 'steel':
      return 'スチール（既定）';
    case 'yellow':
      return 'マスタード';
    case 'cyan':
      return 'ティール';
    case 'red':
      return 'テラコッタ';
    case 'white':
      return 'アイボリー';
    case 'purple':
      return 'モーブ';
  }
}

/** 未付与の人に見せる特別枠の見本（選べない・見た目だけ）。ゴールドは管理者付与の代表色
 *（retune でシャンパンゴールド寄りの落ち着いた色に変更）。 */
const LOCKED_SPECIAL = [
  { key: 'gold', ringClass: 'ring-special', style: specialVars('#c8a45a'), label: 'ゴールド（見本・付与された人だけ選べます）' },
  { key: 'prism', ringClass: 'ring-special ring-prism', style: undefined, label: 'プリズム（見本・付与された人だけ選べます）' },
] as const;

/**
 * 設定画面「枠の色」（2026-09-16 さつき承認のデザイン案の section E 準拠）。通常6色は誰でも選べる。
 * 特別枠は管理者付与（`special_frame`）が無いとロック表示のみで選べない。バッジのオン/オフ
 * トグルは無い（付与されたら常に出す。さつき指示）。選択は即時反映（楽観更新→失敗なら戻す）。
 */
function FramePicker(props: { profile: MyProfile; onChanged: (patch: { frame_color: FrameColor }) => void }): JSX.Element {
  const [busy, setBusy] = useState<FrameColor | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // MyProfile.frame_color は DB 由来の string（防御的に広く持つ）。ここでは表示・送信用に
  // FrameColor として扱う（未知の値が来ても resolveAvatarDeco 側が steel に丸めるので安全）。
  const current = props.profile.frame_color as FrameColor;
  const granted = props.profile.special_frame;
  const grantedDeco = granted ? resolveAvatarDeco({ frame_color: 'special', special_frame: granted }) : null;

  async function pick(value: FrameColor): Promise<void> {
    if (busy || value === current) return;
    setErr(null);
    setBusy(value);
    const prev = current;
    props.onChanged({ frame_color: value }); // 楽観更新。
    const r = await updateFrameColor(value);
    if (!r.ok) {
      props.onChanged({ frame_color: prev });
      setErr(r.message);
    }
    setBusy(null);
  }

  return (
    <div className="fr-sheet">
      <div className="ttl">枠の色</div>
      <div className="fr-sw">
        {NORMAL_FRAME_COLORS.map((c) => {
          const deco = resolveAvatarDeco({ frame_color: c });
          return (
            <button
              key={c}
              type="button"
              className={`${deco.ringClass}${current === c ? ' on' : ''}`}
              aria-label={frameColorLabel(c)}
              aria-pressed={current === c}
              disabled={busy != null}
              onClick={() => void pick(c)}
            />
          );
        })}
      </div>
      <div className="names">
        {NORMAL_FRAME_COLORS.map((c) => (
          <span key={c}>{frameColorLabel(c).replace('（既定）', '')}</span>
        ))}
      </div>
      <div className="sub">SPECIAL ─ {granted ? '付与済み' : '付与された人だけ選べます'}</div>
      <div className="fr-sw">
        {granted && grantedDeco ? (
          <button
            type="button"
            className={`${grantedDeco.ringClass}${current === 'special' ? ' on' : ''}`}
            style={grantedDeco.ringStyle}
            aria-label="付与された特別枠"
            aria-pressed={current === 'special'}
            disabled={busy != null}
            onClick={() => void pick('special')}
          />
        ) : (
          LOCKED_SPECIAL.map((l) => (
            <button key={l.key} type="button" className={`${l.ringClass} lock`} style={l.style} aria-label={l.label} aria-pressed={false} disabled>
              <span>🔒</span>
            </button>
          ))
        )}
      </div>
      {err && <p className="auth-err avpick-err">{err}</p>}
    </div>
  );
}

/** 「アップデートを確認」ボタンの文言。 */
function updateButtonLabel(phase: UpdatePhase): string {
  switch (phase) {
    case 'checking':
      return '確認中…';
    case 'available':
      return '新しいバージョンに更新する';
    case 'applying':
      return '更新しています…';
    default:
      return 'アップデートを確認';
  }
}

/** ボタンの下に出す結果メッセージ（無ければ null）。 */
function updateNote(phase: UpdatePhase, blocked: boolean): string | null {
  if (blocked) return '計算中は更新できません。計算が終わると押せます。';
  if (phase === 'latest') return '最新のバージョンです。';
  if (phase === 'error') return '確認できませんでした。電波の良い所でもう一度お試しください。';
  return null;
}

/**
 * 設定画面（M7・モック s-profile 準拠）。表示名／パスワード変更・公開既定トグル・
 * アプリの更新（版の表示・手動確認）・ログアウト・アカウント削除。すべて RLS 下で本人のみ。
 * アイコンは端末内で正方形に切り出して 256px へ縮小・再圧縮してから `avatars` バケットへ上げる
 * （`supabase/avatar.ts`）。元の解像度のままは上げない。
 * ※ handle 変更（synthetic email 付け替え・Edge Function 要）は対象外＝読み取り専用。
 *   ログイン成功/削除後は App の onAuthStateChange がゲート（認証画面）へ戻す。
 */
export function Settings(props: {
  onBack: () => void;
  onOpenAdmin: () => void;
  /** 計算中（入れ替えると計算が止まるので、アップデートのボタンを押せなくする）。 */
  updateBlocked: boolean;
}): JSX.Element {
  const [profile, setProfile] = useState<MyProfile | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const upd = useAppUpdate();
  const avatarSrc = useStorageImage(profile?.avatar_url ?? null, 'avatars');

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
  const updNote = updateNote(upd.phase, props.updateBlocked);
  const deco = resolveAvatarDeco(profile);

  return (
    <div className="settings">
      <div className="avpick">
        <div className={`avbig ${deco.ringClass}`} style={deco.ringStyle}>
          {avatarSrc ? <img src={avatarSrc} alt="" /> : initial}
          {deco.badge && <AvatarBadge id={deco.badge} />}
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

      {profile && (
        <FramePicker
          profile={profile}
          onChanged={(patch) => setProfile((prev) => (prev ? { ...prev, ...patch } : prev))}
        />
      )}

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
        <h2 className="scr-h sm">アプリの更新</h2>
        <div className="readout">
          <div className="row">
            <span className="lb">バージョン</span>
            <span className="vl">{upd.version}</span>
          </div>
        </div>
        <button
          type="button"
          className="btn ghost"
          disabled={props.updateBlocked || upd.phase === 'checking' || upd.phase === 'applying'}
          onClick={() => void checkForUpdate()}
        >
          {updateButtonLabel(upd.phase)}
        </button>
        {updNote && <p className="upd-note">{updNote}</p>}
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
          <h3>アプリの更新</h3>
          <p>新しいバージョンは、アプリを開いたとき（裏から戻したときも含む）に自動で入ります。入力の途中や計算中は入れ替えず、画面の上にお知らせを出します。「今すぐ更新」を押すか、次に開いたときに自動で入ります。</p>
          <p>「アップデートを確認」を押すと、その場で最新かどうかを確かめ、新しいバージョンがあればすぐに入れ替えます。</p>
          <h3>保存について</h3>
          <p>計算した局面・結果・スクショ（端末内で圧縮した版）はサーバに保存されます。端末を変えてもログインすれば記録は残ります。</p>
          <h3>スクリーンショットの扱い</h3>
          <p>スクショは非公開です。見られるのは本人と管理者だけで、クラブの他のメンバーには見えません。</p>
          <p>管理者は、不具合や読み取りの間違いを調べるために、計算の記録（非公開のものを含む）とスクショを確認することがあります。</p>
          <p>OCR がうまく読めなかった画像は、読み取り精度を改善するために保持されます。そのため記録を削除しても、読めなかった画像だけはサーバに残る場合があります。</p>
          <h3>不具合の記録</h3>
          <p>アプリで想定外のエラーが起きたときは、原因を調べるために、エラーの内容・起きた画面・端末の種類（機種・画面の大きさ）を自動でサーバに送ります。入力中の内容や画像は送りません。見られるのは管理者だけで、90日で自動的に削除されます。</p>
          <h3>アカウントの削除</h3>
          <p>削除すると、記録・公開したスレッド・画像もすべて消えます。取り消せません。</p>
        </InfoModal>
      )}
    </div>
  );
}
