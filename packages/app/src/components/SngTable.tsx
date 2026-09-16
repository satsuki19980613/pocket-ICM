/**
 * SIT & GO の卓（2〜6 席）。docs/SNG_DESIGN.md §5（A3a 所有）。
 *
 * レイアウトは Ten-Four（実在のポーカーアプリ）の卓を参考にした視認性重視の構成
 * （さつき指示: 名前・スタックを大きく明るく／プレートやチップが重ならない／席の
 * プレートが主役）。配色・質感（暗いサイバー調のガラス卓・シアン/イエローの
 * アクセント・面取り clip-path・Rajdhani/Share Tech Mono）は Slumbot HU（`SlumbotTable.tsx`）
 * と同じ CSS 変数を使うが、DOM とクラス名（`sgt-*`）は独立させている。Slumbot HU 側の
 * `.sb-*`（同じ HandView を描く別画面）に影響しないようにするためで、`SlumbotTable.tsx`
 * 自体は変更しない。カード（`Card`/`Hand`/`Backs`）だけは重複実装を避けるため
 * `SlumbotTable.tsx` から import して使う。
 *
 * 席の配置は 2〜6 人ぶんを `SLOTS`（% 座標）で縦長カプセルの卓の外周に置き、極端な
 * 左右の席（`x` が 0/100 に近いもの）は中央寄せにすると 320px 幅でプレートが画面外へ
 * はみ出すため、左右の画面端に固定で寄せる（`sng-play.css` の `.sgt-seat.anchor-l/-r`）。
 */

import {
  ACTION_MS,
  type ActionKind,
  type ActionRecord,
  type PlayerState,
  type PublicHand,
  type PublicTable,
  type You,
} from '@oshihiki/sng';
import { formatBbDisplay } from '@oshihiki/core';

import { Backs, Card, Hand } from './SlumbotTable';
import { STREET_LABEL } from '../slumbot/rules';

/**
 * 人数別の席スロット（コンテナ % 座標, [x,y]）。先頭=手前(下)中央, 以降は時計回り。
 * 卓が縦長カプセルになったため（Ten-Four 準拠）、上下に長く・左右は端へ寄せる座標にしている。
 */
const SLOTS: Record<number, readonly (readonly [number, number])[]> = {
  2: [
    [50, 93],
    [50, 9],
  ],
  3: [
    [50, 93],
    [8, 38],
    [92, 38],
  ],
  4: [
    [50, 93],
    [8, 56],
    [50, 9],
    [92, 56],
  ],
  5: [
    [50, 93],
    [8, 72],
    [22, 12],
    [78, 12],
    [92, 72],
  ],
  6: [
    [50, 93],
    [8, 74],
    [8, 26],
    [50, 9],
    [92, 26],
    [92, 74],
  ],
};

/** 席のアンカー（左右端は中央寄せにせず画面端へ固定する。sng-play.css 側の同名クラス参照）。 */
type Anchor = 'anchor-l' | 'anchor-c' | 'anchor-r';
function anchorFor(x: number): Anchor {
  if (x <= 20) return 'anchor-l';
  if (x >= 80) return 'anchor-r';
  return 'anchor-c';
}

/** 直前アクションのピルの色分け（Fold=青 / Check=グレー / Call=緑 / Bet・Raise=赤 / All-in=黄）。 */
const ACTION_KIND_CLASS: Record<ActionKind, string> = {
  fold: 'k-fold',
  check: 'k-check',
  call: 'k-call',
  bet: 'k-bet',
  raise: 'k-raise',
  allin: 'k-allin',
};

function actionPillLabel(a: ActionRecord, bb: number): string {
  const bbAmt = (chips: number): string => `${formatBbDisplay(chips / bb)}bb`;
  let body: string;
  switch (a.kind) {
    case 'fold':
      body = 'Fold';
      break;
    case 'check':
      body = 'Check';
      break;
    case 'call':
      body = `Call ${bbAmt(a.put)}`;
      break;
    case 'bet':
      body = `Bet ${bbAmt(a.betTo)}`;
      break;
    case 'raise':
      body = `Raise ${bbAmt(a.betTo)}`;
      break;
    case 'allin':
      body = `All-in ${bbAmt(a.betTo)}`;
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

interface ActionPill {
  readonly cls: string;
  readonly label: string;
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
  readonly isActing: boolean;
  readonly remainSec: number | null;
  readonly remainPct: number | null;
  /** そのストリートでこの席が最後に取ったアクション（acting 中・settled 後は親が null にする）。 */
  readonly pill: ActionPill | null;
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

  const anchor = anchorFor(props.x);
  // ピル（アクション/ベット）を出す向きは卓の中心へ寄る方向を座席の位置から決める
  // （上半分は下向き＝席の下、下半分は上向き＝席の上）。anchor-l/anchor-r の席は左右の
  // 向きだけで決まるため dir クラスの CSS 側では参照しない（sng-play.css 参照）。
  const dir = props.y < 50 ? 'dir-down' : 'dir-up';
  // 上端・下端の席は「％で中心を置く」と、カード＋プレート＋タイマーの高さぶん卓の外へ
  // はみ出す（縦に余裕が無い端末ほど顕著）。端の席だけは % を使わず CSS 側で上下端に
  // 貼り付ける（`.sgt-seat.edge-top` / `.edge-bottom`）。
  const edge = props.y <= 12 ? ' edge-top' : props.y >= 88 ? ' edge-bottom' : '';
  const style =
    edge !== '' ? (anchor === 'anchor-c' ? { left: `${props.x}%` } : {}) : anchor === 'anchor-c' ? { top: `${props.y}%`, left: `${props.x}%` } : { top: `${props.y}%` };

  const tags: JSX.Element[] = [];
  if (!player.connected) tags.push(<span key="warn-conn" className="sgt-tag warn">切断中</span>);
  if (player.status === 'sitout') tags.push(<span key="warn-sitout" className="sgt-tag warn">SIT OUT</span>);
  if (player.status === 'left') tags.push(<span key="warn-left" className="sgt-tag warn">退室</span>);
  if (out) tags.push(<span key="out" className="sgt-tag out">{player.place ? `${player.place}位` : 'OUT'}</span>);

  return (
    <div
      className={`sgt-seat ${anchor} ${dir}${edge}${props.isHero ? ' hero' : ' bot'}${props.isActing ? ' acting' : ''}${folded || out ? ' folded' : ''}${out ? ' out' : ''}`}
      style={style}
    >
      <div className="sgt-cards">
        {showCards ? <Hand cards={showCards} big={props.isHero} /> : !out && (showBacks ? <Backs /> : <div className="sgt-cardsp" />)}
      </div>
      <div className="sgt-plate">
        <span className="sgt-name" title={player.name}>
          {player.name}
        </span>
        <span className="sgt-sub">
          {props.badge && <span className={`sgt-pos p-${props.badge.toLowerCase()}`}>{props.badge}</span>}
          <span className="sgt-stack">{formatBbDisplay(remaining / bb)}bb</span>
        </span>
      </div>
      {props.isActing && props.remainSec != null && (
        <div className="sgt-timer">
          <i style={{ width: `${props.remainPct ?? 0}%` }} />
          <b>{props.remainSec}</b>
        </div>
      )}
      {tags.length > 0 && <div className="sgt-tags">{tags}</div>}
      {/* アクションのピルと出したチップは 1 つの箱に積む（個別に絶対配置すると、片方が
          無いときに隙間が空き、隣の席のピルと近づいて読みづらくなる）。
          フォールド/脱落した席のチップは出さない（そのストリートに出した額はポットへ流れた
          扱いで、「降りた席にチップが残っている」ように見せない）。エンジン側の fold 時
          streetBet 上書きは 2026-09-15 の QA で直っているが、表示の方針として残す。 */}
      {(props.pill || (streetBet > 0 && !folded && !out)) && (
        <div className="sgt-pills">
          {props.pill && <span className={`sgt-act ${props.pill.cls}`}>{props.pill.label}</span>}
          {streetBet > 0 && !folded && !out && <span className="sgt-bet">{formatBbDisplay(streetBet / bb)}bb</span>}
        </div>
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

  const bb = hand?.bb ?? 200;
  const pot = hand ? hand.commits.reduce((a, c) => a + c, 0) : 0;
  const remainMs = hand?.deadline != null ? Math.max(0, hand.deadline - props.now) : null;
  const remainSec = remainMs != null ? Math.ceil(remainMs / 1000) : null;
  // 残り時間バーは ACTION_MS を満タンとみなした概算（タイムバンク延長中は 100% に張り付く）。
  // 表示する秒数自体は deadline から常に正確なので、バーは目安の可視化と割り切る。
  const remainPct = remainMs != null ? Math.max(0, Math.min(100, (remainMs / ACTION_MS) * 100)) : null;

  // そのストリートで各席が最後に取ったアクション（席ごとに 1 件・Map<seat, ActionRecord>）。
  // hand.actions を街の先頭から辿って上書きしていくので、残るのは各席の最後の 1 件になる。
  // ストリートが変わるとこの Map ごと作り直されるので、前のストリートぶんは自然に消える。
  const lastActionsByStreet = new Map<number, ActionRecord>();
  if (hand) {
    for (const a of hand.actions) {
      if (a.street === hand.street) lastActionsByStreet.set(a.seat, a);
    }
  }

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
    <div className="sgt">
      <div className="sgt-felt" />
      <div className="sgt-mid">
        {hand && <span className="sgt-street">{STREET_LABEL[hand.street] ?? 'PREFLOP'}</span>}
        <div className="sgt-potline">
          <span className="sgt-pot-lbl">POT</span>
          <b className="sgt-pot">{formatBbDisplay(pot / bb)}bb</b>
          {pot > 0 && hand?.phase !== 'settled' && (
            <span className="sgt-spr">SPR {spr < 100 ? spr.toFixed(1) : Math.round(spr)}</span>
          )}
        </div>
        <div className="sgt-board">
          {[0, 1, 2, 3, 4].map((i) => {
            const c = hand?.board[i];
            return c ? <Card key={`${c}-${i}`} code={c} /> : <span key={i} className="sgt-slot" />;
          })}
        </div>
      </div>

      {table.players.map((p, seat) => {
        const [x, y] = slots[(seat - mySeat + n) % n] ?? slots[0]!;
        const isActing = hand != null && hand.toAct === seat && hand.phase === 'betting';
        // acting 中はタイマーを見せる方が読みやすいのでピルを出さない。settled（精算後）も
        // 結果バナーと混ざるため出さない。
        const lastAction = !isActing && hand?.phase !== 'settled' ? lastActionsByStreet.get(seat) ?? null : null;
        const pill: ActionPill | null = lastAction
          ? { cls: ACTION_KIND_CLASS[lastAction.kind], label: actionPillLabel(lastAction, bb) }
          : null;
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
            isActing={isActing}
            remainSec={isActing ? remainSec : null}
            remainPct={isActing ? remainPct : null}
            pill={pill}
          />
        );
      })}
    </div>
  );
}
