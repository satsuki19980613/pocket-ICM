/**
 * SIT & GO の卓（2〜6 席）。docs/SNG_DESIGN.md §5（A3a 所有）。
 *
 * 見た目は Slumbot HU（`SlumbotTable.tsx`）と同じ部品を使う（さつき指示: 「デザインは
 * Slumbot と同じデザインを採用」）。カード（`Card`/`Hand`/`Backs`）は SlumbotTable から
 * そのまま import し、卓のガラス面（`sb-felt`）・席のプレート（`sb-plate`/`sb-pos`/
 * `sb-stack`）・出したチップ（`sb-bet`）・吹き出し（`sb-bubble`）も同じクラスを使う。
 * 席の配置だけは 2〜6 人ぶん楕円上に散らす必要があるので、`PokerTable.tsx` と同じ
 * `SLOTS`（% 座標）で `sb-seat` に `style={{left,top}}` を直接当てて上書きする
 * （`.sb-seat.bot`/`.sb-seat.hero` の固定 top はインラインスタイルが常に勝つので競合しない）。
 *
 * Slumbot に無い要素（プレイヤー名・BTN バッジ・SIT OUT/切断/脱落タグ・複数人の吹き出し
 * 方向）だけを sng-play.css に追加する。
 */

import { formatBbDisplay } from '@oshihiki/core';
import type { ActionRecord, PlayerState, PublicHand, PublicTable, You } from '@oshihiki/sng';

import { Backs, Card, Hand } from './SlumbotTable';
import { STREET_LABEL } from '../slumbot/rules';

/**
 * 人数別の席スロット（コンテナ % 座標, [x,y]）。先頭=手前(下)中央, 以降は時計回り。
 *
 * 左右端の席は 320/375px 幅でプレート（バッジ＋名前＋スタック）が画面外に切れる不具合が
 * あったため（さつき実機確認済み）、極端な席（x が 0/100 に近いもの）は少し内側へ寄せて
 * 余白を確保している。プレート側の縮小（sng-play.css の `.sg-seat .sb-plate`）と合わせて
 * 320px 幅でも収まることを確認済み。
 */
const SLOTS: Record<number, readonly (readonly [number, number])[]> = {
  2: [
    [50, 84],
    [50, 13],
  ],
  3: [
    [50, 84],
    [16, 22],
    [84, 22],
  ],
  4: [
    [50, 85],
    [14, 47],
    [50, 11],
    [86, 47],
  ],
  5: [
    [50, 86],
    [15, 58],
    [24, 16],
    [76, 16],
    [85, 58],
  ],
  6: [
    [50, 87],
    [13, 57],
    [22, 13],
    [50, 7],
    [78, 13],
    [87, 57],
  ],
};

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

export type ResultBannerKind = 'win' | 'lose' | 'push' | 'other';
export interface ResultBanner {
  readonly kind: ResultBannerKind;
  readonly text: string;
  /** 自分が関与していた（=このハンドで折れていない）か。ラベル SHOWDOWN/HAND OVER の出し分けに使う。 */
  readonly showdown: boolean;
}

/**
 * ショーダウン後〜次のハンドまで（`phase === 'settled'`）に卓の中央へ出す結果。
 * 自分が関与した（=このハンドで折れていない）なら自分の収支、降ろして終わった／
 * 自分が関与していないなら勝者名と額（分け合いは複数名・` ・ ` 区切り）。
 */
export function computeResultBanner(table: PublicTable, hand: PublicHand, mySeat: number | null): ResultBanner | null {
  if (hand.phase !== 'settled' || !hand.won) return null;
  const won = hand.won;
  const bb = hand.bb;
  const involved = mySeat != null && hand.folded[mySeat] === false;
  if (involved) {
    const net = won[mySeat!]! - hand.commits[mySeat!]!;
    const kind: ResultBannerKind = net > 0 ? 'win' : net < 0 ? 'lose' : 'push';
    return { kind, text: signedBb(net, bb), showdown: true };
  }
  const winners = table.players
    .map((p, seat) => ({ name: p.name, net: (won[seat] ?? 0) - hand.commits[seat]! }))
    .filter((w) => w.net > 0);
  if (winners.length === 0) return null;
  return {
    kind: 'other',
    text: winners.map((w) => `${w.name} ${signedBb(w.net, bb)}`).join(' ・ '),
    showdown: false,
  };
}

/**
 * ハンド終了時の収支バナー。Slumbot HU の `HandResult`（SlumbotTable.tsx）と**同じ枠**
 * （`.sb-result` 系クラス）・**同じ置き場所**（卓の下、ベット操作の代わりに出す）を使うが、
 * 中身の数値は再利用しない: `HandResult` 内部の `bbLabel` は Slumbot 固定の BB=100 チップで
 * 換算しており、レベルで BB が変わる SIT & GO にはそのまま使えない（流用すると誤った bb
 * 換算になる）。加えて「自分は関与していない・勝者名を出す」ケースは `HandResult` の
 * props（数値 1 つ）では表現できない。そのため見た目のクラスだけ揃えた専用コンポーネントに
 * している（SngRoom.tsx が `<SngTable/>` の下に置く）。
 */
export function SgHandResult(props: { banner: ResultBanner }): JSX.Element {
  const { banner } = props;
  const cls = banner.kind === 'other' ? 'sb-result' : `sb-result ${banner.kind}`;
  return (
    <div className={cls}>
      <span className="sb-result-lbl">{banner.showdown ? 'SHOWDOWN' : 'HAND OVER'}</span>
      <b className={`sb-result-val${banner.kind === 'other' ? ' other' : ''}`}>{banner.text}</b>
    </div>
  );
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
  readonly isActing: boolean;
  readonly remainSec: number | null;
}

function SeatSlot(props: SeatSlotProps): JSX.Element | null {
  const { player, hand, seat } = props;
  if (!player) return null;
  const out = player.status === 'out';
  const folded = hand?.folded[seat] === true;
  const shown = hand?.shown[seat];
  const showCards = props.isHero ? props.heroCards : (shown ?? null);
  const showBacks = !showCards && !folded && !out && hand != null;
  const bb = hand?.bb ?? 200;

  // ハンド中はスタックが動かない見た目にならないよう、開始スタックから拠出額を引いた
  // 「残りスタック」を出す（エンジンは commits を別持ちにしていて player.stack はハンド
  // 終了まで変えない設計のため・packages/sng/src/engine/hand.ts 冒頭コメント）。
  // 精算後（settled）は獲得分を足して、勝った席が「0bb」に見えないようにする。
  const remaining = hand
    ? Math.max(0, (hand.startStacks[seat] ?? player.stack) - hand.commits[seat]! + (hand.won?.[seat] ?? 0))
    : player.stack;
  const streetBet = hand?.streetBet[seat] ?? 0;

  // 吹き出し・チップは卓の中心へ寄せる向きを座席の位置から決める（上半分は下向き＝
  // Slumbot の bot 席と同じ、下半分は上向き＝Slumbot の hero 席と同じ）。チップは横に
  // 出す Slumbot の教訓を守り、中心が右にある席（x<=50）は右、左にある席は左へ。
  const dir = props.y < 50 ? 'dir-down' : 'dir-up';
  const betMirror = props.x > 50;

  return (
    <div
      className={`sb-seat sg-seat ${dir}${props.isHero ? ' hero' : ' bot'}${props.isActing ? ' active' : ''}${folded || out ? ' folded' : ''}`}
      style={{ left: `${props.x}%`, top: `${props.y}%` }}
    >
      {showCards ? (
        <Hand cards={showCards} big={props.isHero} />
      ) : (
        !out && (showBacks ? <Backs /> : <div className="sg-cardsp" />)
      )}
      <div className="sb-plate">
        {props.badge && <span className={`sb-pos p-${props.badge.toLowerCase()}`}>{props.badge}</span>}
        <span className="sb-name" title={player.name}>
          {player.name}
        </span>
        <span className="sb-stack">{formatBbDisplay(remaining / bb)}bb</span>
      </div>
      <div className="sg-substack">
        {!player.connected && <span className="sg-tag warn">切断中</span>}
        {player.status === 'sitout' && <span className="sg-tag warn">SIT OUT</span>}
        {player.status === 'left' && <span className="sg-tag warn">退室</span>}
        {out && <span className="sg-tag out">{player.place ? `${player.place}位` : 'OUT'}</span>}
      </div>
      {/* フォールド/脱落した席のチップは出さない（そのストリートに出した額はポットへ流れた扱いで、
          Slumbot と同じく「降りた席にチップが残っている」ように見せない）。
          エンジン側の fold 時 streetBet 上書きは 2026-09-15 の QA で直っているが、表示の方針として残す。 */}
      {streetBet > 0 && !folded && !out && (
        <span className={`sb-bet${betMirror ? ' mirror' : ''}`}>{formatBbDisplay(streetBet / bb)}bb</span>
      )}
      {props.isActing && props.remainSec != null ? (
        <span className="sb-bubble thinking">{props.remainSec}秒</span>
      ) : (
        props.bubble && <span className="sb-bubble">{props.bubble}</span>
      )}
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

  // SPR は「自分の残りスタック ÷ ポット」（Slumbot HU と同じ流儀）。
  const myRemaining =
    hand && mySeat != null
      ? Math.max(0, (hand.startStacks[mySeat] ?? table.players[mySeat]?.stack ?? 0) - hand.commits[mySeat]!)
      : 0;
  const spr = hand && pot > 0 ? myRemaining / pot : 0;

  const badgeFor = (seat: number): 'BTN' | 'SB' | 'BB' | null => {
    if (!hand) return null;
    if (hand.bbSeat === seat) return 'BB';
    if (hand.sbSeat === seat) return 'SB';
    if (hand.btn === seat) return 'BTN';
    return null;
  };

  return (
    <div className="sb-felt sg-felt">
      <div className="sb-mid">
        <div className="sb-potline">
          {hand && <span className="sb-street">{STREET_LABEL[hand.street] ?? 'PREFLOP'}</span>}
          <span className="sb-pot-lbl">POT</span>
          <span className="sb-pot-val">{formatBbDisplay(pot / bb)}bb</span>
          {pot > 0 && hand?.phase !== 'settled' && <span className="sb-spr">SPR {spr < 100 ? spr.toFixed(1) : Math.round(spr)}</span>}
        </div>
        <div className="sb-board">
          {[0, 1, 2, 3, 4].map((i) => {
            const c = hand?.board[i];
            return c ? <Card key={`${c}-${i}`} code={c} /> : <span key={i} className="sb-slot" />;
          })}
        </div>
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
            isActing={hand != null && hand.toAct === seat && hand.phase === 'betting'}
            remainSec={remainSec}
          />
        );
      })}
    </div>
  );
}
