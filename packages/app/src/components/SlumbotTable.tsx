/**
 * Slumbot ヘッズアップ卓の描画。
 *
 * 6 人卓（PokerTable.tsx）と違い席は 2 つだけなので、両サイドを持たず
 * 「上＝Slumbot / 下＝自分」の縦並びに固定する。カードの見た目（4 色デッキ・
 * 面取りプレート・mono 数値）はアプリの HUD テーマを踏襲する。
 */

import { bbLabel } from '../slumbot/rules';
import type { LastAction } from '../slumbot/hand';
import type { HandView } from '../slumbot/hand';

const SUIT_GLYPH: Record<string, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };

/**
 * "Ah" / "Td" のような表記を 1 枚のカードに描く。
 * SIT & GO の卓（SngTable.tsx）も同じ見た目を使うため export する（重複実装を避ける）。
 */
export function Card(props: { code: string; big?: boolean }): JSX.Element | null {
  const rank = props.code[0];
  const suit = props.code[1]?.toLowerCase();
  if (!rank || !suit || !SUIT_GLYPH[suit]) return null;
  return (
    <div className={`pt-card suit-${suit}${props.big ? ' sb-big' : ''}`}>
      <span className="pt-rank">{rank === 'T' ? '10' : rank}</span>
      <span className="pt-suit">{SUIT_GLYPH[suit]}</span>
    </div>
  );
}

export function Hand(props: { cards: readonly string[]; big?: boolean }): JSX.Element {
  return (
    <div className="pt-hand">
      {props.cards.map((c, i) => (
        <Card key={`${c}-${i}`} code={c} big={props.big} />
      ))}
    </div>
  );
}

export function Backs(): JSX.Element {
  return (
    <div className="pt-backs">
      <span className="pt-back" />
      <span className="pt-back" />
    </div>
  );
}

/** 席のポジション表記。HU は SB(=BTN) と BB の 2 つだけ。 */
function posLabel(seat: number): 'SB' | 'BB' {
  return seat === 1 ? 'SB' : 'BB';
}

interface SeatProps {
  readonly seat: number;
  readonly stack: number;
  readonly bet: number;
  readonly cards: readonly string[] | null;
  readonly hero: boolean;
  readonly active: boolean;
  readonly bubble: string | null;
  readonly thinking: boolean;
}

function Seat(props: SeatProps): JSX.Element {
  return (
    <div className={`sb-seat${props.hero ? ' hero' : ' bot'}${props.active ? ' active' : ''}`}>
      {props.cards ? <Hand cards={props.cards} big={props.hero} /> : <Backs />}
      <div className="sb-plate">
        <span className={`sb-pos p-${posLabel(props.seat).toLowerCase()}`}>{posLabel(props.seat)}</span>
        <span className="sb-stack">{bbLabel(props.stack, 1)}bb</span>
      </div>
      {props.bet > 0 && <span className="sb-bet">{bbLabel(props.bet, 1)}bb</span>}
      {props.thinking ? (
        <span className="sb-bubble thinking">思考中<span className="sb-dots" /></span>
      ) : (
        props.bubble && <span className="sb-bubble">{props.bubble}</span>
      )}
    </div>
  );
}

export function SlumbotTable(props: {
  view: HandView;
  last: LastAction | null;
  /** 相手の応答待ち（＝Slumbot が考えている）。 */
  thinking: boolean;
  streetLabel: string;
}): JSX.Element {
  const { view } = props;
  const { state } = view;
  const hero = view.heroSeat;
  const bot = view.botSeat;

  // SPR は「自分の残りスタック ÷ ポット」。ポット 0 は起こらないが念のため守る。
  const spr = view.pot > 0 ? (view.stacks[hero] ?? 0) / view.pot : 0;
  const board = view.board;

  const bubbleFor = (seat: number): string | null =>
    props.last && props.last.seat === seat ? props.last.label : null;

  return (
    <div className="sb-felt">
      <Seat
        seat={bot}
        stack={view.stacks[bot] ?? 0}
        bet={state.streetBet[bot] ?? 0}
        cards={view.botCards}
        hero={false}
        active={!view.over && state.toAct === bot}
        bubble={bubbleFor(bot)}
        thinking={props.thinking}
      />

      <div className="sb-mid">
        {/* ストリートは独立した行にせずポットの行へ寄せる。縦を 1 行ぶん詰めることで、
            画面の短い端末でも席の吹き出しと中央の表示がぶつからない。 */}
        <div className="sb-potline">
          <span className="sb-street">{props.streetLabel}</span>
          <span className="sb-pot-lbl">POT</span>
          <span className="sb-pot-val">{bbLabel(view.pot, 1)}bb</span>
          {view.pot > 0 && !view.over && (
            <span className="sb-spr">SPR {spr < 100 ? spr.toFixed(1) : Math.round(spr)}</span>
          )}
        </div>
        <div className="sb-board">
          {[0, 1, 2, 3, 4].map((i) => {
            const c = board[i];
            return c ? <Card key={`${c}-${i}`} code={c} /> : <span key={i} className="sb-slot" />;
          })}
        </div>
      </div>

      <Seat
        seat={hero}
        stack={view.stacks[hero] ?? 0}
        bet={state.streetBet[hero] ?? 0}
        cards={view.holeCards}
        hero
        active={view.heroToAct}
        bubble={bubbleFor(hero)}
        thinking={false}
      />
    </div>
  );
}

/** ハンド終了時の収支バナー。 */
export function HandResult(props: { winnings: number; showdown: boolean }): JSX.Element {
  const won = props.winnings > 0;
  return (
    <div className={`sb-result ${won ? 'win' : props.winnings < 0 ? 'lose' : 'even'}`}>
      <span className="sb-result-lbl">{props.showdown ? 'SHOWDOWN' : 'HAND OVER'}</span>
      <b className="sb-result-val">
        {props.winnings === 0 ? '±0' : `${won ? '+' : '−'}${bbLabel(Math.abs(props.winnings), 1)}`}
        <span className="sb-result-unit">bb</span>
      </b>
    </div>
  );
}
