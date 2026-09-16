/**
 * Slumbot ヘッズアップ卓の描画。
 *
 * 卓そのもの（座席配置・プレート・ピル・ボード）は SIT & GO と共有の `GlassTable.tsx`
 * （旧 `SngTable.tsx` から切り出したもの）を使う。以前はここに専用の `.sb-felt`/`.sb-seat`/
 * 丸い吹き出し（`.sb-bubble`）を実装していたが、SIT & GO の卓が新デザイン（Ten-Four 参考の
 * 縦長カプセル卓）に作り替わり、Slumbot だけ旧デザインのまま取り残されていたのを揃えた。
 * このファイルは `HandView` を `GlassTable` の view-model（`FeltSeat[]`）へ変換するだけの
 * 薄いアダプタで、ハンド結果（`HandResult`）は `.sb-result` 系クラスを SIT & GO と共有済み
 * なのでそのまま残す。
 */

import { GlassTable, type FeltSeat, type PillTag } from './GlassTable';
import { bbLabel } from '../slumbot/rules';
import type { LastAction } from '../slumbot/hand';
import type { HandView } from '../slumbot/hand';
import { lastActionsOnStreet, type StreetAction } from '../slumbot/streetActions';

/** 席のポジション表記。HU は SB(=BTN) と BB の 2 つだけ。 */
function posLabel(seat: number): 'SB' | 'BB' {
  return seat === 1 ? 'SB' : 'BB';
}

/** 直前アクションのピルの色分け。SngTable.tsx の ACTION_KIND_CLASS と同じ割り当て
    （Fold=青 / Check=灰 / Call=緑 / Bet・Raise=赤 / All-in=黄）。Slumbot 側の
    `LastAction.kind` は 'allin' を持たず bet/raise の `allIn` フラグで表すので、
    ここで k-allin への差し替えを行う。 */
const ACTION_KIND_CLASS: Record<StreetAction['kind'], string> = {
  fold: 'k-fold',
  check: 'k-check',
  call: 'k-call',
  bet: 'k-bet',
  raise: 'k-raise',
};

function pillClass(a: StreetAction): string {
  if (a.allIn && (a.kind === 'bet' || a.kind === 'raise')) return 'k-allin';
  return ACTION_KIND_CLASS[a.kind];
}

/**
 * ピルの文言。SngTable.tsx の `actionPillLabel` と同じ流儀（大文字化しない・額は
 * `bbLabel(x, 1)` で桁を揃える）で組み立てる。Slumbot 既存の `LastAction.label`
 * （"CALL 2.5bb" のような大文字表記）はここでは使わない——`.sgt-act` は大文字化しない
 * 設計で、大文字のまま出すとアプリ全体の「25.9bb」表記と字面がずれる
 * （sng-play.css の `.sgt-act` コメント参照）。
 *
 * Call の額は `betTo`（そのストリートの累計）ではなく `put`（そのアクションで実際に
 * 場へ出した増分）を使う。S&G 側の `actionPillLabel`（SngTable.tsx）も
 * `ActionRecord.put` を使っており、揃えないと「Call 2.5bb」の 2.5 の意味が
 * 両画面で食い違う（betTo だと「そのストリートに今まで出した累計」になってしまう）。
 * SIT & GO の「（自動）」サフィックスは Slumbot には自動処理の概念が無いので付けない。
 */
function pillLabel(a: StreetAction): string {
  switch (a.kind) {
    case 'fold':
      return 'Fold';
    case 'check':
      return 'Check';
    case 'call':
      return `Call ${bbLabel(a.put, 1)}bb`;
    case 'bet':
      return a.allIn ? `All-in ${bbLabel(a.betTo, 1)}bb` : `Bet ${bbLabel(a.betTo, 1)}bb`;
    case 'raise':
      return a.allIn ? `All-in ${bbLabel(a.betTo, 1)}bb` : `Raise ${bbLabel(a.betTo, 1)}bb`;
  }
}

export function SlumbotTable(props: {
  view: HandView;
  /** アーミング（revealMs の間ボタンを止める）判定に SlumbotView.tsx 側で使うので、
      表示に使わなくなった今も props からは外さない。 */
  last: LastAction | null;
  /** 相手の応答待ち（＝Slumbot が考えている）。bot 席の待ち表示に出す。 */
  thinking: boolean;
  streetLabel: string;
  /**
   * hero（自分）のアイコン。`getMyProfile()` は非同期なので、SlumbotView.tsx は届くまで
   * `{ src: null, initial: '?' }` 相当（枠と頭文字だけ）を渡し、届いたら差し替える。
   * 省略時は画像なし・initial '?' 扱い（枠の大きさは変わらないのでレイアウトは動かない）。
   */
  heroAvatar?: { readonly src: string | null; readonly initial: string };
}): JSX.Element {
  const { view } = props;
  const { state } = view;
  const hero = view.heroSeat;
  const bot = view.botSeat;

  // そのストリートで各席が最後に取ったアクション（席番号 → StreetAction）。ハンド終了後は
  // 結果バナーと混ざるため使わない（S&G の phase === 'settled' と同じ扱い）。
  const actionsByStreet = view.over ? null : lastActionsOnStreet(view.action, state.street);

  const buildSeat = (seat: number): FeltSeat => {
    const isHero = seat === hero;
    // 応答待ちの間は、その席を「手番の席」と同じ扱いにする。S&G は手番の席にタイマーを
    // 出してピルを消す（どこを見ればいいかを 1 箇所に絞る）ので、Slumbot でも待っている
    // 相手の席でだけ待ち表示を出し、直前のピルは引っ込める。これをやらないと bot の席に
    // 「Bet 1bb」と「思考中」が同時に並んで、どちらが今の状態なのか読み取れない。
    const waiting = !isHero && props.thinking;
    const isActing = waiting || (!view.over && state.toAct === seat);
    const folded = state.folded && state.folder === seat;

    const cards = isHero ? view.holeCards : view.botCards;
    // bot はショーダウンで botCards が開示されるまで裏。hero は常に自分の手札を表向きに
    // 見せる（holeCards が空になることは実運用では無いが、念のため裏へフォールバックする）。
    // ただし降りた席には裏も出さない（＝空の場所だけ残す）。SIT & GO の卓が
    // `showBacks = !showCards && !folded && ...` としているのと同じ扱いで、揃えないと
    // 「bot が降りたのにカードを持ったまま」に見える。
    const backs = (!cards || cards.length === 0) && !folded;

    const a: StreetAction | null = !isActing && actionsByStreet ? actionsByStreet.get(seat) ?? null : null;
    const pill: PillTag | null = a ? { cls: pillClass(a), label: pillLabel(a) } : null;

    const streetBet = state.streetBet[seat] ?? 0;

    return {
      key: seat === hero ? 'hero' : 'bot',
      name: isHero ? 'あなた' : 'Slumbot',
      stackText: `${bbLabel(view.stacks[seat] ?? 0, 1)}bb`,
      badge: posLabel(seat),
      cards: cards && cards.length > 0 ? cards : null,
      backs,
      hero: isHero,
      acting: isActing,
      folded,
      // HU に脱落席という概念は無い（負けても次のハンドが配られる）。
      out: false,
      // 手番の残り秒数は無い（Slumbot はターン制限が無く、代わりに応答待ち＝waiting を出す）。
      timer: null,
      waiting,
      pill,
      betText: !view.over && streetBet > 0 ? `${bbLabel(streetBet, 1)}bb` : null,
      tags: [],
      // Slumbot はプログラムなので、人物アイコンではなく専用の記号 1 文字にする
      // （実在のサービス・人物を模さない）。
      avatar: isHero ? (props.heroAvatar ?? { src: null, initial: '?' }) : { src: null, initial: '♠' },
    };
  };

  // GlassTable は「先頭=hero（手前・下）、以降は時計回り」の前提で座標を割り当てる
  // （2 人卓なら [hero, bot] で「下=自分／上=Slumbot」になる。SLOTS[2] 参照）。
  const seats: FeltSeat[] = [buildSeat(hero), buildSeat(bot)];

  // SPR は「自分の残りスタック ÷ ポット」。ポット 0 は起こらないが念のため守る。
  const spr = view.pot > 0 ? (view.stacks[hero] ?? 0) / view.pot : 0;

  return (
    <GlassTable
      seats={seats}
      street={props.streetLabel}
      potText={`${bbLabel(view.pot, 1)}bb`}
      sprText={view.pot > 0 && !view.over ? `SPR ${spr < 100 ? spr.toFixed(1) : Math.round(spr)}` : null}
      board={view.board}
    />
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
