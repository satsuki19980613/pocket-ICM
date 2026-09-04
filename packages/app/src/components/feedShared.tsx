import type { FeedAuthor } from '../supabase/feed';

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

/** アバター（画像 URL があれば画像、無ければ表示名の頭文字）。 */
export function Avatar(props: { author: FeedAuthor; onClick?: () => void }): JSX.Element {
  const initial = props.author.display_name.trim().charAt(0) || '?';
  const inner = props.author.avatar_url ? (
    <img src={props.author.avatar_url} alt="" />
  ) : (
    initial
  );
  if (props.onClick) {
    return (
      <button type="button" className="av av-btn" onClick={props.onClick} aria-label={`${props.author.display_name} の公開結果`}>
        {inner}
      </button>
    );
  }
  return <div className="av">{inner}</div>;
}
