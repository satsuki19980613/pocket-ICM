/**
 * ハンド履歴の「詳細」の共通ビューモデル（Slumbot HU / SIT & GO の両方をこの形に寄せる）。
 *
 * 画面（`HandDetailModal`）はこの形だけを知っていればよく、記録の形の違い
 * （HU は Slumbot の action 文字列・SNG は圧縮レコード）は各ビルダーが吸収する。
 * ポット（そのストリートが始まった時点の額）は記録から毎回導く——保存はしていないので、
 * **すでに登録済みの履歴もこのビルダーを通せばポットが出る**（移行は要らない）。
 *
 * 単位は「そのハンドの bb」。小数第 2 位で四捨五入（docs/DATA_LEDGER.md の bb 表記と同じ）。
 */

/** 1 手（fold / check / call / bet / raise / all-in）。 */
export interface HandStepView {
  /** ポジション（'SB' | 'BB' | 'UTG' | 'HJ' | 'CO' | 'BTN'）。不明は '?'。 */
  readonly pos: string;
  /** 表示名（自分は 'YOU'）。 */
  readonly name: string;
  readonly isHero: boolean;
  /** 'FOLD' | 'CHECK' | 'CALL' | 'BET' | 'RAISE' | 'ALL IN'。 */
  readonly label: string;
  /** そのストリートの「〜まで」の額（bb）。fold / check は null。 */
  readonly amountBb: number | null;
  readonly allIn: boolean;
  /** SIT & GO の自動アクション（席を立った人の自動フォールド等）。 */
  readonly auto: boolean;
}

/** 1 ストリート。 */
export interface HandStreetView {
  /** 0=preflop … 3=river */
  readonly street: number;
  /** 'PREFLOP' | 'FLOP' | 'TURN' | 'RIVER'。 */
  readonly label: string;
  /** そのストリートが**始まった時点**のポット（bb・アンティ/ブラインド込み）。 */
  readonly potBb: number;
  /** そのストリートで新たにめくれたカード（preflop は空・flop は 3 枚・turn/river は 1 枚）。 */
  readonly board: readonly string[];
  readonly steps: readonly HandStepView[];
}

/** 卓に着いていた 1 人（席順ではなくポジション順＝UTG→BB で並べる）。 */
export interface HandPlayerView {
  readonly seat: number;
  readonly pos: string;
  readonly name: string;
  readonly isHero: boolean;
  /** このハンドの純収支（bb）。分からなければ null。 */
  readonly netBb: number | null;
  /** 分かっている手札（2 枚）。非公開は null。 */
  readonly cards: readonly string[] | null;
}

export interface HandResultView {
  /** 勝った人の表示名（チョップは複数）。分からなければ空。 */
  readonly winners: readonly string[];
  /** 勝者が持ち帰った額（bb）。分からなければ null。 */
  readonly wonBb: number | null;
  readonly showdown: boolean;
  /** 最終ポット（bb・全員の拠出の合計）。 */
  readonly finalPotBb: number;
  /** 補足（'ALL-IN EV +1.2bb'・'だれそれ 脱落（4位）' など）。 */
  readonly notes: readonly string[];
}

export interface HandDetailView {
  /** 一覧の行と対応する一意キー。 */
  readonly key: string;
  /** モーダルの見出し（HU は '9/15 21:17'・SNG は '#12 ・ Level 3'）。 */
  readonly title: string;
  /** 見出しの下の一行（SNG の試合の要約など）。無ければ null。 */
  readonly subtitle: string | null;
  readonly heroCards: readonly string[] | null;
  readonly players: readonly HandPlayerView[];
  readonly streets: readonly HandStreetView[];
  readonly result: HandResultView;
}

export const STREET_VIEW_LABEL = ['PREFLOP', 'FLOP', 'TURN', 'RIVER'] as const;

/** チップ → bb（小数第 2 位で四捨五入）。 */
export function toBbView(chips: number, bb: number): number {
  return Math.round((chips / bb) * 100) / 100;
}
