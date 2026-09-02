/**
 * ポーカーテーブル描画（§7.4 Drill）。フェルトを HUD レーダーに見立て、残り人数で席を配置。
 * hero は常に手前（下）中央。villain は伏せカード、hero のみ 4 色デッキで表向き大。
 *
 * 席は state.seats（＝positionsForPlayersLeft のアクション順）を hero が先頭に来るよう
 * 回転させ、下→周囲のスロットに割り当てる。
 */

import type { BoardState, Position } from '@oshihiki/core';

/** 人数別の席スロット（コンテナ % 座標, [x,y]）。先頭=手前(下)中央, 以降は周回。 */
const SLOTS: Record<number, [number, number][]> = {
  2: [
    [50, 84],
    [50, 13],
  ],
  3: [
    [50, 84],
    [14, 21],
    [86, 21],
  ],
  4: [
    [50, 85],
    [10, 47],
    [50, 11],
    [90, 47],
  ],
  5: [
    [50, 86],
    [11, 58],
    [23, 15],
    [77, 15],
    [89, 58],
  ],
  6: [
    [50, 87],
    [9, 57],
    [21, 14],
    [50, 8],
    [79, 14],
    [91, 57],
  ],
};

const SUIT_GLYPH: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };

interface CardFace {
  rank: string;
  suit: 's' | 'h' | 'd' | 'c';
}

/**
 * ハンドクラス（"A5s" / "AKo" / "77"）→ 表向き 2 枚の面。スート自体は無関係なので
 * 「スーテッド＝同スート・オフスート/ペア＝別スート」を視覚的に明示しつつ 4 色デッキを見せる。
 * ♦=青（このゲームの 4 色デッキ）を suited に当ててシグネチャーを効かせる。
 */
function heroCardFaces(hand: string): [CardFace, CardFace] {
  const r0 = hand[0]!;
  const r1 = hand[1]!;
  const suited = hand.endsWith('s');
  const pair = hand.length === 2 && r0 === r1;
  if (pair) return [{ rank: r0, suit: 'h' }, { rank: r0, suit: 's' }];
  if (suited) return [{ rank: r0, suit: 'd' }, { rank: r1, suit: 'd' }];
  return [{ rank: r0, suit: 's' }, { rank: r1, suit: 'h' }];
}

/** 表示用ランク（T→10）。 */
function rankLabel(r: string): string {
  return r === 'T' ? '10' : r;
}

function HeroCards(props: { hand: string }): JSX.Element {
  const faces = heroCardFaces(props.hand);
  return (
    <div className="pt-hand">
      {faces.map((f, i) => (
        <div key={i} className={`pt-card suit-${f.suit}`}>
          <span className="pt-rank">{rankLabel(f.rank)}</span>
          <span className="pt-suit">{SUIT_GLYPH[f.suit]}</span>
        </div>
      ))}
    </div>
  );
}

export function PokerTable(props: { state: BoardState; heroHand: string }): JSX.Element {
  const { state } = props;
  const n = state.playersLeft;
  const slots = SLOTS[n] ?? SLOTS[6]!;
  const seats = state.seats;
  const heroIdx = Math.max(0, seats.findIndex((s) => s.pos === state.heroPos));
  // hero を先頭に回転（手前スロットへ）。
  const rotated = seats.map((_, i) => seats[(heroIdx + i) % seats.length]!);

  return (
    <div className={`pt-felt pt-n${n}`}>
      <div className="pt-pot">
        <span className="pt-pot-lbl">POT</span>
        <span className="pt-pot-val">{state.pot}bb</span>
      </div>
      {rotated.map((s, i) => {
        const [x, y] = slots[i] ?? slots[0]!;
        const isHero = s.pos === state.heroPos;
        return (
          <div
            key={s.pos}
            className={`pt-seat${isHero ? ' hero' : ''}`}
            style={{ left: `${x}%`, top: `${y}%` }}
          >
            {isHero ? (
              <HeroCards hand={props.heroHand} />
            ) : (
              <div className="pt-backs">
                <span className="pt-back" />
                <span className="pt-back" />
              </div>
            )}
            <div className="pt-plate">
              <span className={`pt-pos${isHero ? ' hero' : ''}`}>{s.pos as Position}</span>
              <span className="pt-stack">{s.stack + s.bet}bb</span>
            </div>
            {s.bet > 0 && <span className="pt-bet">{s.bet}</span>}
            {isHero && <span className="pt-turn">手番</span>}
          </div>
        );
      })}
    </div>
  );
}
