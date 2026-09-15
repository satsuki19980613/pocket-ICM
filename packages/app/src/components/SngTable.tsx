/**
 * SIT & GO の卓（2〜6 席）。docs/SNG_DESIGN.md §5（A3a 所有）。
 *
 * 席の配置は `PokerTable.tsx`（AOF ドリルの 6 人卓）の SLOTS と同じ座標を使う
 * （アプリ全体で「自分は必ず下・時計回りに周回」の見え方をそろえる）。カードの見た目
 * （4 色デッキ・面取りプレート）は `SlumbotTable.tsx` と同じ `pt-card`/`pt-hand`/`pt-backs`
 * クラスをそのまま使う。
 */

import { formatBbDisplay } from '@oshihiki/core';
import type { ActionRecord, PlayerState, PublicHand, PublicTable, You } from '@oshihiki/sng';

const SUIT_GLYPH: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };

/** 人数別の席スロット（コンテナ % 座標, [x,y]）。先頭=手前(下)中央, 以降は時計回り。 */
const SLOTS: Record<number, readonly (readonly [number, number])[]> = {
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

function rankLabel(r: string): string {
  return r === 'T' ? '10' : r;
}

function Card(props: { code: string; big?: boolean }): JSX.Element | null {
  const rank = props.code[0];
  const suit = props.code[1]?.toLowerCase();
  if (!rank || !suit || !SUIT_GLYPH[suit]) return null;
  return (
    <div className={`pt-card suit-${suit}${props.big ? ' sg-big' : ''}`}>
      <span className="pt-rank">{rankLabel(rank)}</span>
      <span className="pt-suit">{SUIT_GLYPH[suit]}</span>
    </div>
  );
}

function Hand(props: { cards: readonly string[]; big?: boolean }): JSX.Element {
  return (
    <div className="pt-hand">
      {props.cards.map((c, i) => (
        <Card key={`${c}-${i}`} code={c} big={props.big} />
      ))}
    </div>
  );
}

function Backs(): JSX.Element {
  return (
    <div className="pt-backs">
      <span className="pt-back" />
      <span className="pt-back" />
    </div>
  );
}

function actionLabel(a: ActionRecord, bb: number): string {
  const bbAmt = (chips: number): string => `${formatBbDisplay(chips / bb)}bb`;
  let body: string;
  switch (a.kind) {
    case 'fold':
      body = 'FOLD';
      break;
    case 'check':
      body = 'CHECK';
      break;
    case 'call':
      body = `CALL ${bbAmt(a.put)}`;
      break;
    case 'bet':
      body = `BET ${bbAmt(a.betTo)}`;
      break;
    case 'raise':
      body = `RAISE ${bbAmt(a.betTo)}`;
      break;
    case 'allin':
      body = `ALL IN ${bbAmt(a.betTo)}`;
      break;
  }
  return a.auto ? `${body}（自動）` : body;
}

/** 収支の符号つき bb 表記（Slumbot HU の HandResult と同じ流儀・"−" は全角ハイフンでなく減算記号）。 */
function signedBb(chips: number, bb: number): string {
  if (chips === 0) return `±${formatBbDisplay(0)}bb`;
  const v = formatBbDisplay(Math.abs(chips) / bb);
  return `${chips > 0 ? '+' : '−'}${v}bb`;
}

type ResultBannerKind = 'win' | 'lose' | 'push' | 'other';
interface ResultBanner {
  readonly kind: ResultBannerKind;
  readonly text: string;
}

/**
 * ショーダウン後〜次のハンドまで（`phase === 'settled'`）に卓の中央へ出す結果。
 * 自分が関与した（=このハンドで折れていない）なら自分の収支、降ろして終わった／
 * 自分が関与していないなら勝者名と額（分け合いは複数名・` ・ ` 区切り）。
 */
function computeResultBanner(table: PublicTable, hand: PublicHand, mySeat: number | null): ResultBanner | null {
  if (hand.phase !== 'settled' || !hand.won) return null;
  const won = hand.won;
  const bb = hand.bb;
  const involved = mySeat != null && hand.folded[mySeat] === false;
  if (involved) {
    const net = won[mySeat!]! - hand.commits[mySeat!]!;
    if (net > 0) return { kind: 'win', text: `WIN ${signedBb(net, bb)}` };
    if (net < 0) return { kind: 'lose', text: signedBb(net, bb) };
    return { kind: 'push', text: signedBb(net, bb) };
  }
  const winners = table.players
    .map((p, seat) => ({ name: p.name, net: (won[seat] ?? 0) - hand.commits[seat]! }))
    .filter((w) => w.net > 0);
  if (winners.length === 0) return null;
  return { kind: 'other', text: winners.map((w) => `${w.name} ${signedBb(w.net, bb)}`).join(' ・ ') };
}

interface SeatSlotProps {
  readonly seat: number;
  readonly x: number;
  readonly y: number;
  readonly player: PlayerState | undefined;
  readonly isHero: boolean;
  readonly hand: PublicHand | null;
  readonly heroCards: readonly [string, string] | null;
  readonly badge: 'BTN' | 'SB' | 'BB' | null;
  readonly bubble: string | null;
  readonly remainSec: number | null;
}

function SeatSlot(props: SeatSlotProps): JSX.Element | null {
  const { player, hand, seat } = props;
  if (!player) return null;
  const out = player.status === 'out';
  const folded = hand?.folded[seat] === true;
  const isActing = hand != null && hand.toAct === seat;
  const shown = hand?.shown[seat];
  const showCards = props.isHero
    ? props.heroCards
    : shown ?? null;
  const showBacks = !showCards && !folded && !out && hand != null;
  const streetBet = hand?.streetBet[seat] ?? 0;
  const bb = hand?.bb ?? 200;

  return (
    <div
      className={`pt-seat sg-seat${props.isHero ? ' hero' : ''}${isActing ? ' active' : ''}${folded || out ? ' folded' : ''}`}
      style={{ left: `${props.x}%`, top: `${props.y}%` }}
    >
      {showCards ? (
        <Hand cards={showCards} big={props.isHero} />
      ) : (
        !out && (showBacks ? <Backs /> : <div className="sg-cardsp" />)
      )}
      <div className="pt-plate sg-plate">
        {props.badge && <span className={`sg-badge b-${props.badge.toLowerCase()}`}>{props.badge}</span>}
        <span className="sg-name" title={player.name}>
          {player.name}
        </span>
      </div>
      <div className="sg-substack">
        <span className="pt-stack">{formatBbDisplay(player.stack / bb)}bb</span>
        {!player.connected && <span className="sg-tag warn">切断中</span>}
        {player.status === 'sitout' && <span className="sg-tag warn">SIT OUT</span>}
        {player.status === 'left' && <span className="sg-tag warn">退室</span>}
        {out && <span className="sg-tag out">{player.place ? `${player.place}位` : 'OUT'}</span>}
      </div>
      {streetBet > 0 && <span className="pt-bet">{formatBbDisplay(streetBet / bb)}bb</span>}
      {isActing && props.remainSec != null && (
        <span className="pt-turn sg-turn">{props.remainSec}秒</span>
      )}
      {props.bubble && <span className="sg-bubble">{props.bubble}</span>}
    </div>
  );
}

export function SngTable(props: { table: PublicTable; you: You; heroCards: readonly [string, string] | null; now: number }): JSX.Element {
  const { table, you } = props;
  const hand = table.hand;
  const n = table.players.length;
  const slots = SLOTS[n] ?? SLOTS[6]!;
  const mySeat = you.seat ?? 0;

  const lastAction = hand && hand.actions.length > 0 ? hand.actions[hand.actions.length - 1]! : null;
  const bb = hand?.bb ?? 200;
  const pot = hand ? hand.commits.reduce((a, c) => a + c, 0) : 0;
  const remainSec =
    hand?.deadline != null ? Math.max(0, Math.ceil((hand.deadline - props.now) / 1000)) : null;
  const resultBanner = hand ? computeResultBanner(table, hand, you.seat) : null;

  const badgeFor = (seat: number): 'BTN' | 'SB' | 'BB' | null => {
    if (!hand) return null;
    if (hand.bbSeat === seat) return 'BB';
    if (hand.sbSeat === seat) return 'SB';
    if (hand.btn === seat) return 'BTN';
    return null;
  };

  return (
    <>
      {/* 卓の外（楕円の上）の帯。楕円の内側に置くと上の席のカード裏・バッジと重なるため
          （さつき実機確認済みの罠）、常にここで独立した行として出す。 */}
      <div className="sg-headline">
        {hand ? (
          <>
            <span className="sg-hand-no">#{hand.handNo}</span>
            <span className="sg-headline-dot">・</span>
            <span className="sg-level">
              L{hand.level} {hand.sb}/{hand.bb}
              {hand.ante > 0 ? ` (${hand.ante})` : ''}
            </span>
          </>
        ) : (
          <span className="sg-level">開始を待っています…</span>
        )}
      </div>

      <div className={`pt-felt sg-felt sg-n${n}`}>
        <div className="pt-pot sg-mid">
          <span className="pt-pot-lbl">POT</span>
          <span className="pt-pot-val">{formatBbDisplay(pot / bb)}bb</span>
          <div className="sg-board">
            {[0, 1, 2, 3, 4].map((i) => {
              const c = hand?.board[i];
              return c ? <Card key={`${c}-${i}`} code={c} /> : <span key={i} className="sg-slot" />;
            })}
          </div>
          {resultBanner && <div className={`sg-hres sg-hres-${resultBanner.kind}`}>{resultBanner.text}</div>}
        </div>

        {table.players.map((p, seat) => {
          const [x, y] = slots[(seat - mySeat + n) % n] ?? slots[0]!;
          return (
            <SeatSlot
              key={p.userId}
              seat={seat}
              x={x}
              y={y}
              player={p}
              isHero={seat === mySeat}
              hand={hand}
              heroCards={props.heroCards}
              badge={badgeFor(seat)}
              bubble={lastAction && lastAction.seat === seat ? actionLabel(lastAction, bb) : null}
              remainSec={remainSec}
            />
          );
        })}
      </div>
    </>
  );
}
