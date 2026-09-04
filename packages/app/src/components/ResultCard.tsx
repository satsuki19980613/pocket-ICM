import { feedCardOf, type FeedResult } from '../supabase/feed';
import type { SampleCard, Suit } from '../data/cardTypes';

const SUIT_SYM: Record<Suit, string> = { spade: '♠', heart: '♥', diamond: '♦', club: '♣' };

/**
 * 公開結果のサマリーカード（Home フィード・Thread 見出し・userpub 共通）。
 * 解（solution）から判定/レンジ/EV/bb/手札を導いて描く。onOpen 指定でタップ可能。
 */
export function ResultCard(props: { result: FeedResult; onOpen?: () => void }): JSX.Element {
  const c = feedCardOf(props.result);
  const cls = `rescard${c.verdict === 'FOLD' ? ' fold' : ''}`;
  const inner = (
    <>
      <div className="rc-top">
        <div className="hand">
          <Card card={c.cards[0]} />
          <Card card={c.cards[1]} />
        </div>
        <span className={`rc-verdict ${c.verdict === 'PUSH' ? 'push' : 'fold'}`}>{c.verdict}</span>
        <span className="rc-seat">
          {c.playersLeft} LEFT · {c.heroPos}
        </span>
      </div>
      <div className="rc-bot">
        <span>{c.bb != null ? `${c.bb}bb` : '—'}</span>
        <span>PU {c.pu.toFixed(1)}%</span>
        <span>
          EV {c.ev >= 0 ? '+' : ''}
          {c.ev.toFixed(3)}pt
        </span>
      </div>
    </>
  );
  if (props.onOpen) {
    return (
      <button type="button" className={cls} onClick={props.onOpen}>
        {inner}
      </button>
    );
  }
  return <div className={cls}>{inner}</div>;
}

function Card(props: { card: SampleCard }): JSX.Element {
  return (
    <span className={`fcard ${props.card.s}`}>
      {props.card.r}
      <em>{SUIT_SYM[props.card.s]}</em>
    </span>
  );
}
