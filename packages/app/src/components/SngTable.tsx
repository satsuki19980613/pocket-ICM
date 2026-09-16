/**
 * SIT & GO の卓（2〜6 席）。docs/SNG_DESIGN.md §5（A3a 所有）。
 *
 * 卓そのものの描画（座席配置・プレート・ピル・ボード）は `GlassTable.tsx` に切り出した
 * （Slumbot HU 側の卓が旧デザインのまま取り残されていたのを、この卓のデザインへ揃えるため。
 * さつき指示: 見た目は 1px も変えない）。このファイルは `PublicTable`/`PublicHand`/`You` を
 * `GlassTable` の view-model（`FeltSeat[]`）へ変換して渡すだけの薄いアダプタで、
 * ハンド結果バナー（`computeResultBanner`/`SgHandResult`）は SIT & GO 固有のロジック
 * （SngRoom.tsx が卓の下に置く）なのでこのファイルに残す。
 *
 * 配色・質感（暗いサイバー調のガラス卓・シアン/イエローのアクセント・面取り clip-path・
 * Rajdhani/Share Tech Mono）は Slumbot HU と共通の CSS 変数・クラス（`sgt-*`）を使う。
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

import { GlassTable, type FeltSeat, type SeatTag } from './GlassTable';
import { STREET_LABEL } from '../slumbot/rules';
import type { AvatarDecoInput } from '../avatarDeco';

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

/**
 * 席の既定アイコン（画像があれば画像、無ければ名前の頭文字。`feedShared.tsx` の `Avatar` と
 * 同じ流儀）を組み立てる。`avatarUrl` は PlayerState 由来で、古い部屋の状態だと undefined に
 * なりうる（`PlayerState.avatarUrl` の型コメント参照）ので、ここで null に丸める。
 * `deco`（frameColor/specialFrame/badge）も同じ理由（古い部屋の状態）で undefined になりうる
 * ので省略可にしてあり、`GlassTable` 側の `resolveAvatarDeco` が steel・バッジ無しに丸める。
 * 純関数として切り出してあるのはテストのため（buildSeat 自体は table/hand/props に依存し
 * 単体では呼びにくい）。
 */
export function seatAvatarOf(
  name: string,
  avatarUrl: string | null | undefined,
  deco?: AvatarDecoInput,
): NonNullable<FeltSeat['avatar']> {
  return { src: avatarUrl ?? null, initial: name.trim().charAt(0).toUpperCase() || '?', deco };
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

export function SngTable(props: {
  table: PublicTable;
  you: You;
  heroCards: readonly [string, string] | null;
  now: number;
}): JSX.Element {
  const { table, you } = props;
  const hand = table.hand;
  const n = table.players.length;
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

  /** 1 席ぶんの PublicTable/PublicHand を GlassTable の view-model（FeltSeat）へ変換する。 */
  const buildSeat = (seat: number, player: PlayerState): FeltSeat => {
    const out = player.status === 'out';
    const folded = hand?.folded[seat] === true;
    const shown = hand?.shown[seat];
    const isHero = seat === mySeat;
    const showCards = isHero ? props.heroCards : (shown ?? null);
    const showBacks = !showCards && !folded && !out && hand != null;

    // ハンド中はスタックが動かない見た目にならないよう、開始スタックから拠出額を引いた
    // 「残りスタック」を出す（エンジンは commits を別持ちにしていて player.stack はハンド
    // 終了まで変えない設計のため・packages/sng/src/engine/hand.ts 冒頭コメント）。
    // 精算後（settled）は獲得分を足して、勝った席が「0bb」に見えないようにする。
    const remaining = hand
      ? Math.max(0, (hand.startStacks[seat] ?? player.stack) - hand.commits[seat]! + (hand.won?.[seat] ?? 0))
      : player.stack;
    const streetBet = hand?.streetBet[seat] ?? 0;

    const isActing = hand != null && hand.toAct === seat && hand.phase === 'betting';
    // acting 中はタイマーを見せる方が読みやすいのでピルを出さない。settled（精算後）も
    // 結果バナーと混ざるため出さない。
    const lastAction = !isActing && hand?.phase !== 'settled' ? lastActionsByStreet.get(seat) ?? null : null;
    const pill = lastAction ? { cls: ACTION_KIND_CLASS[lastAction.kind], label: actionPillLabel(lastAction, bb) } : null;

    const tags: SeatTag[] = [];
    if (!player.connected) tags.push({ key: 'warn-conn', cls: 'warn', text: '切断中' });
    if (player.status === 'sitout') tags.push({ key: 'warn-sitout', cls: 'warn', text: 'SIT OUT' });
    if (player.status === 'left') tags.push({ key: 'warn-left', cls: 'warn', text: '退室' });
    if (out) tags.push({ key: 'out', cls: 'out', text: player.place ? `${player.place}位` : 'OUT' });

    return {
      key: player.userId,
      name: player.name,
      stackText: `${formatBbDisplay(remaining / bb)}bb`,
      badge: badgeFor(seat),
      cards: showCards,
      backs: showBacks,
      hero: isHero,
      acting: isActing,
      folded,
      out,
      timer: isActing && remainSec != null ? { sec: remainSec, pct: remainPct ?? 0 } : null,
      waiting: false,
      pill,
      // フォールド/脱落した席のチップは出さない（そのストリートに出した額はポットへ流れた
      // 扱いで、「降りた席にチップが残っている」ように見せない）。エンジン側の fold 時
      // streetBet 上書きは 2026-09-15 の QA で直っているが、表示の方針として残す。
      betText: streetBet > 0 && !folded && !out ? `${formatBbDisplay(streetBet / bb)}bb` : null,
      tags,
      // 本人のアイコン（`profiles.avatar_url` 由来）。無ければ名前の頭文字に落とす
      // （`feedShared.tsx` の `Avatar` と同じ流儀）。枠＋バッジも同じ PlayerState 由来。
      avatar: seatAvatarOf(player.name, player.avatarUrl, {
        frame_color: player.frameColor,
        special_frame: player.specialFrame,
        badge: player.badge,
      }),
    };
  };

  // 先頭 = hero（手前・下）、以降は時計回りに座席番号を辿る（GlassTable の SLOTS がその
  // 前提で組まれている）。table.players は実座席番号でインデックスされている。
  const seats: FeltSeat[] = Array.from({ length: n }, (_, i) => {
    const seat = (mySeat + i) % n;
    return buildSeat(seat, table.players[seat]!);
  });

  return (
    <GlassTable
      seats={seats}
      street={hand ? STREET_LABEL[hand.street] ?? 'PREFLOP' : null}
      potText={`${formatBbDisplay(pot / bb)}bb`}
      sprText={pot > 0 && hand?.phase !== 'settled' ? `SPR ${spr < 100 ? spr.toFixed(1) : Math.round(spr)}` : null}
      board={hand?.board ?? []}
    />
  );
}
