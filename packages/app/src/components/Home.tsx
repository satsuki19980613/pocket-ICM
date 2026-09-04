import type { FeedAuthor, FeedPost } from '../supabase/feed';
import { ResultCard } from './ResultCard';
import { Avatar, relTime } from './feedShared';

export type FeedState = 'loading' | 'error' | 'ready';

/**
 * ホーム（M6 公開フィード）。クラブの公開結果がスレッドとして新しい順に並ぶ。
 * 投稿カードのタップ＝スレッド詳細（コメント/返信/♡）。投稿者タップ＝その人の公開結果。
 */
export function Home(props: {
  state: FeedState;
  posts: FeedPost[];
  onOpenThread: (threadId: string) => void;
  onOpenAuthor: (author: FeedAuthor) => void;
  onToggleLike: (threadId: string, on: boolean) => void;
  onRetry: () => void;
}): JSX.Element {
  if (props.state === 'loading') {
    return (
      <div className="feed">
        <div className="panel solving">
          <div className="spinner" />
          <p>フィードを読み込み中…</p>
        </div>
      </div>
    );
  }
  if (props.state === 'error') {
    return (
      <div className="feed">
        <div className="home-empty">
          <p>フィードを取得できませんでした。</p>
          <button type="button" className="btn ghost" onClick={props.onRetry}>
            再読み込み
          </button>
        </div>
      </div>
    );
  }
  if (props.posts.length === 0) {
    return (
      <div className="feed">
        <div className="home-empty">
          <p>まだ公開された結果がありません。</p>
          <small>計算結果の画面で「ホームで公開する」をオンにすると、ここに並びます。</small>
        </div>
      </div>
    );
  }
  return (
    <div className="feed">
      {props.posts.map((p) => (
        <PostCard
          key={p.thread_id}
          post={p}
          onOpenThread={() => props.onOpenThread(p.thread_id)}
          onOpenAuthor={() => props.onOpenAuthor(p.author)}
          onToggleLike={() => props.onToggleLike(p.thread_id, !p.liked_by_me)}
        />
      ))}
    </div>
  );
}

function PostCard(props: {
  post: FeedPost;
  onOpenThread: () => void;
  onOpenAuthor: () => void;
  onToggleLike: () => void;
}): JSX.Element {
  const p = props.post;
  return (
    <article className="post">
      <Avatar author={p.author} onClick={props.onOpenAuthor} />
      <div className="col">
        <div className="meta">
          <button type="button" className="meta-author" onClick={props.onOpenAuthor}>
            <b>{p.author.display_name}</b>
            <i>@{p.author.handle}</i>
          </button>
          <i>・{relTime(p.created_at)}</i>
        </div>
        {p.lead_comment && <p>{p.lead_comment}</p>}
        <ResultCard result={p.result} onOpen={props.onOpenThread} />
        <div className="acts">
          <button type="button" onClick={props.onOpenThread}>
            💬 {p.comment_count}
          </button>
          <button
            type="button"
            className={p.liked_by_me ? 'liked' : undefined}
            aria-pressed={p.liked_by_me}
            onClick={props.onToggleLike}
          >
            {p.liked_by_me ? '♥' : '♡'} {p.like_count}
          </button>
        </div>
      </div>
    </article>
  );
}
