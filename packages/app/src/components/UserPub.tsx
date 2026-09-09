import type { FeedAuthor, FeedPost } from '../supabase/feed';
import { ResultCard } from './ResultCard';
import { Avatar, PostBody, relTime } from './feedShared';
import type { FeedState } from './Home';

/**
 * 他人の公開一覧（M6 userpub・v3 で通常投稿も混在）。
 * 投稿者ヘッダ＋公開結果カード / 通常投稿（→スレッド）。
 */
export function UserPub(props: {
  author: FeedAuthor | null;
  state: FeedState;
  posts: FeedPost[];
  onOpenThread: (threadId: string) => void;
  onRetry: () => void;
}): JSX.Element {
  return (
    <div className="userpub">
      {props.author && (
        <div className="userpub-head">
          <Avatar author={props.author} />
          <div className="col">
            <b>@{props.author.handle}</b>
          </div>
        </div>
      )}

      {props.state === 'loading' && (
        <div className="panel solving">
          <div className="spinner" />
          <p>読み込み中…</p>
        </div>
      )}

      {props.state === 'error' && (
        <div className="home-empty">
          <p>公開結果を取得できませんでした。</p>
          <button type="button" className="btn ghost" onClick={props.onRetry}>
            再読み込み
          </button>
        </div>
      )}

      {props.state === 'ready' && props.posts.length === 0 && (
        <div className="home-empty">
          <p>公開された投稿はまだありません。</p>
        </div>
      )}

      {props.state === 'ready' &&
        props.posts.map((p) => (
          <div className="userpub-item" key={p.thread_id}>
            {p.kind === 'result' && p.result ? (
              <ResultCard result={p.result} onOpen={() => props.onOpenThread(p.thread_id)} />
            ) : (
              <PostBody body={p.body} imageUrl={p.image_url} onOpen={() => props.onOpenThread(p.thread_id)} />
            )}
            <div className="acts">
              <span>💬 {p.comment_count}</span>
              <span>♡ {p.like_count}</span>
              <i>{relTime(p.created_at)}</i>
            </div>
          </div>
        ))}
    </div>
  );
}
