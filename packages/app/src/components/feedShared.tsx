import type { FeedAuthor } from '../supabase/feed';
import { useStorageImage } from '../supabase/storageUrls';
import { AvatarBadge, resolveAvatarDeco } from '../avatarDeco';

/** ISO 時刻 → 相対表記（たった今 / N分 / N時間 / N日 / 月日）。純関数。 */
export function relTime(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const sec = Math.max(0, Math.floor((now - t) / 1000));
  if (sec < 60) return 'たった今';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}分`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}時間`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}日`;
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * 通常投稿の本文＋画像（v3・SPEC §5.1）。Home フィードカード・userpub 一覧の要約表示に使う
 * （タップでスレッドを開く。ResultCard と同じ「カード自体がボタン」の作法）。
 * スレッド詳細の見出し（自分の投稿の編集・削除つき）は Thread.tsx が別途組む
 * （既存コメントの編集 UI と同じ作法に合わせるため、こちらでは持たない）。
 * 画像はこのアプリの Storage の参照だけを、署名 URL にして出す（storageUrls.ts）。
 */
export function PostBody(props: { body: string | null; imageUrl: string | null; onOpen?: () => void }): JSX.Element {
  const src = useStorageImage(props.imageUrl, 'thread-images');
  const inner = (
    <>
      {props.body && <p className="post-body-text">{props.body}</p>}
      {src && (
        <span className="post-img">
          <img src={src} alt="投稿画像" />
        </span>
      )}
    </>
  );
  if (props.onOpen) {
    return (
      <button type="button" className="post-body" onClick={props.onOpen}>
        {inner}
      </button>
    );
  }
  return <div className="post-body">{inner}</div>;
}

// カメラアイコンは Supabase に依存しない icons.tsx へ移した（ローカル版からも使うため）。
export { CameraIcon } from './icons';

/**
 * アバター（画像があれば画像、無ければ handle の頭文字）。画像は署名 URL で出す。
 * 枠の色＋バッジは `author` の frame_color/special_frame/badge（`avatarDeco.ts` 参照）から
 * 解決する。フィード・スレッド・コメント・userpub すべてここを通る（唯一の実装）。
 */
export function Avatar(props: { author: FeedAuthor; onClick?: () => void }): JSX.Element {
  const initial = props.author.handle.trim().charAt(0).toUpperCase() || '?';
  const src = useStorageImage(props.author.avatar_url, 'avatars');
  const deco = resolveAvatarDeco(props.author);
  const inner = (
    <>
      {src ? <img src={src} alt="" /> : initial}
      {deco.badge && <AvatarBadge id={deco.badge} />}
    </>
  );
  if (props.onClick) {
    return (
      <button
        type="button"
        className={`av av-btn ${deco.ringClass}`}
        style={deco.ringStyle}
        onClick={props.onClick}
        aria-label={`@${props.author.handle} の公開結果`}
      >
        {inner}
      </button>
    );
  }
  return (
    <div className={`av ${deco.ringClass}`} style={deco.ringStyle}>
      {inner}
    </div>
  );
}
