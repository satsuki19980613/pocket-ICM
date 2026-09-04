import type { SampleCard, SamplePost, Suit } from '../data/sampleFeed';

const SUIT_SYM: Record<Suit, string> = { spade: '♠', heart: '♥', diamond: '♦', club: '♣' };

/**
 * ホーム（M6 までのサンプル・フィード）。モックの公開結果フィードを参考にした投稿カード。
 * 結果カードのタップで実ソルバーが解いて本物の計算結果を表示する（App 側 onOpen）。
 * ※ 公開フィードの実データ化（投稿/返信/いいね）は M6「ホーム/スレッド」。
 */
export function Home(props: { posts: SamplePost[]; onOpen: (p: SamplePost) => void }): JSX.Element {
  return (
    <div className="feed">
      <p className="feed-note">
        サンプル表示です。クラブのみんなの公開結果はホーム/スレッド（準備中）で実データになります。
        <br />
        結果カードをタップすると、その局面を実際に計算して表示します。
      </p>
      {props.posts.map((p) => (
        <PostCard key={p.id} post={p} onOpen={() => props.onOpen(p)} />
      ))}
    </div>
  );
}

function PostCard(props: { post: SamplePost; onOpen: () => void }): JSX.Element {
  const p = props.post;
  return (
    <article className="post">
      <div className={`av${p.avatarClass ? ` ${p.avatarClass}` : ''}`}>{p.avatar}</div>
      <div className="col">
        <div className="meta">
          <b>{p.author}</b>
          <i>@{p.handle}</i>
          <i>・{p.time}</i>
        </div>
        <p>{p.comment}</p>
        <button
          type="button"
          className={`rescard${p.verdict === 'FOLD' ? ' fold' : ''}`}
          onClick={props.onOpen}
        >
          <div className="rc-top">
            <div className="hand">
              <Card card={p.cards[0]} />
              <Card card={p.cards[1]} />
            </div>
            <span className={`rc-verdict ${p.verdict === 'PUSH' ? 'push' : 'fold'}`}>{p.verdict}</span>
            <span className="rc-seat">{p.posLabel}</span>
          </div>
          <div className="rc-bot">
            <span>{p.form.stacks[p.form.heroPos]}bb</span>
            <span>{p.pu}</span>
            <span>{p.ev}</span>
          </div>
        </button>
        <div className="acts">
          <span>💬 {p.comments}</span>
          <span>♡ {p.likes}</span>
        </div>
      </div>
    </article>
  );
}

function Card(props: { card: SampleCard }): JSX.Element {
  return (
    <span className={`fcard ${props.card.s}`}>
      {props.card.r}
      <em>{SUIT_SYM[props.card.s]}</em>
    </span>
  );
}
