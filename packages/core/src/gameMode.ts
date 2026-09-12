/**
 * ゲームモード（プライズ表・開始スタック）の定義。SPEC §2.1 の「固定ペイアウト」をモード別に一般化。
 *
 * ポーカーチェイスはモードごとに**順位別ポイント（プライズ）と開始スタック**が異なる。ブラインドは
 * 全モード共通（SB0.5/BB1・ante 0.25bb 全員払い・同じ公式レベル表）なので、ここでは持たない
 * ＝ブラインドは従来どおり `@oshihiki/ocr` の公式表と突き合わせて確定する。
 *
 * 3 系統ある（さつき指定 2026-09-12）:
 *   - **クラブマッチ**: `+5/+3/+2/+1/0/−1`・15,000枚・6人。公式 season23〜30 で不変を確認。
 *   - **ランクマッチ**: STAGE 制で、**STAGE ごとに開始スタックも順位別ポイントも変わる**ため
 *     STAGE の指定が要る。STAGE Ⅰ だけ **4人卓**（6,000枚）で、他は6人卓。
 *   - **レジェンドマッチ**: 2026-04-08 に旧 STAGE Ⅵ を置換。**1試合でレートが2本同時に動く**。
 *       シーズンレート（月次リセット・初期200・0で即時降格）`+40/+15/+3/0/−18/−40`
 *       ベースレート（恒久・卓平均との差で補正）基準値 `+35/+21/+7/−7/−21/−35`
 *     補正は**順位に依存しない＝アフィンシフトなので戦略に影響しない**。2つは目的関数として
 *     食い違う（4位はシーズン±0だがベース−7）ので、どれで解くかは利用者が選ぶ。既定は素点平均。
 *
 * **総チップ＝開始人数 × 開始スタック**（1テーブル・勝者総取りなので試合中も保存される）。
 * 人数がモードで変わる（STAGE Ⅰ は4人）ので、総チップを1定数で持たず積で導出する。
 * 注意: 総チップはモード間で**衝突する**（STAGE Ⅳ=90,000=クラブ, STAGE Ⅴ=120,000=レジェンド）。
 * したがって**総チップからモードを自動判定してはならない**（さつき決定 2026-09-12）。判定は UI の
 * モード選択のみを根拠とし、総チップは「選択と食い違ったときの警告」にだけ使う。
 */

/** ゲームの系統（UI 上段）。 */
export const GAME_KINDS = ['club', 'rank', 'legend'] as const;
export type GameKind = (typeof GAME_KINDS)[number];

/**
 * 対応するゲームモードの識別子。ランクマッチは STAGE、レジェンドマッチは「どの指標で解くか」
 * まで含めて1つの ID にする（プライズ表を ID 一本で引けるようにするため）。
 */
export const GAME_MODES = [
  'club',
  'rank-3',
  'rank-4',
  'rank-5',
  'legend-avg',
  'legend-season',
  'legend-base',
] as const;
export type GameMode = (typeof GAME_MODES)[number];

/** 既定モード（未指定の記録＝v3 以前のデータはすべてクラブマッチ）。 */
export const DEFAULT_GAME_MODE: GameMode = 'club';

export interface GameModeSpec {
  readonly id: GameMode;
  readonly kind: GameKind;
  /** 上段（ゲーム）のラベル。 */
  readonly game: string;
  /** 下段のラベル（STAGE or 指標）。下段の選択が無いモードは undefined。 */
  readonly variant?: string;
  /** 1位→最下位の実払いペイアウト（pt）。残り n 人では先頭 n 個を使う（icm.payoutsForPlayers）。 */
  readonly payouts: readonly number[];
  /** 開始スタック（チップ）。 */
  readonly startingStack: number;
  /** 開始人数。総チップ = startingStack × startingPlayers。 */
  readonly startingPlayers: number;
}

const LEGEND_SEASON = [40, 15, 3, 0, -18, -40] as const;
const LEGEND_BASE = [35, 21, 7, -7, -21, -35] as const;
const LEGEND_AVG = LEGEND_SEASON.map((v, i) => (v + LEGEND_BASE[i]!) / 2);
const LEGEND_COMMON = {
  kind: 'legend' as const,
  game: 'レジェンド',
  startingStack: 20000,
  startingPlayers: 6,
};

const RANK_COMMON = { kind: 'rank' as const, game: 'ランク', startingPlayers: 6 };

export const GAME_MODE_SPECS: { readonly [K in GameMode]: GameModeSpec } = {
  club: {
    id: 'club',
    kind: 'club',
    game: 'クラブ',
    payouts: [5, 3, 2, 1, 0, -1],
    startingStack: 15000,
    startingPlayers: 6,
  },

  // ランクマッチ。数値の出典は攻略 Wiki（2025-10）＋ note（2023〜24）の一致で、公式には
  // STAGE 別の順位別ポイントを記載したページが存在しない（旧 /news/explain0001/ は404）。
  // STAGE Ⅰ・Ⅱ は出典間で値が割れており確定できていないため**まだ載せない**（推測で入れない）。
  'rank-3': { ...RANK_COMMON, id: 'rank-3', variant: 'Ⅲ', payouts: [25, 15, 5, -2, -8, -15], startingStack: 10000 },
  'rank-4': { ...RANK_COMMON, id: 'rank-4', variant: 'Ⅳ', payouts: [30, 18, 6, -4, -13, -20], startingStack: 15000 },
  'rank-5': { ...RANK_COMMON, id: 'rank-5', variant: 'Ⅴ', payouts: [35, 21, 7, -6, -19, -28], startingStack: 20000 },

  'legend-avg': { ...LEGEND_COMMON, id: 'legend-avg', variant: '平均', payouts: LEGEND_AVG },
  'legend-season': { ...LEGEND_COMMON, id: 'legend-season', variant: 'シーズン', payouts: [...LEGEND_SEASON] },
  'legend-base': { ...LEGEND_COMMON, id: 'legend-base', variant: 'ベース', payouts: [...LEGEND_BASE] },
};

/** 系統ごとの下段の選択肢（UI の並び順そのもの）。クラブは下段なし。 */
export const MODES_BY_KIND: { readonly [K in GameKind]: readonly GameMode[] } = {
  club: ['club'],
  rank: ['rank-3', 'rank-4', 'rank-5'],
  legend: ['legend-avg', 'legend-season', 'legend-base'],
};

/** 系統の表示名（上段ボタン）。 */
export const GAME_KIND_LABELS: { readonly [K in GameKind]: string } = {
  club: 'クラブ',
  rank: 'ランク',
  legend: 'レジェンド',
};

export function gameModeSpec(mode: GameMode | undefined): GameModeSpec {
  return GAME_MODE_SPECS[mode ?? DEFAULT_GAME_MODE];
}

/** 場の総チップ（開始人数 × 開始スタック）。1テーブル・勝者総取りなので試合中も不変。 */
export function totalChipsOf(mode: GameMode | undefined): number {
  const s = gameModeSpec(mode);
  return s.startingStack * s.startingPlayers;
}

/** 表示用のモード名。下段があれば「ランクマッチ STAGE Ⅳ」「レジェンドマッチ（平均）」の形。 */
export function gameModeLabel(mode: GameMode | undefined): string {
  const s = gameModeSpec(mode);
  if (s.kind === 'rank') return `ランクマッチ STAGE ${s.variant}`;
  if (s.kind === 'legend') return `レジェンドマッチ（${s.variant}）`;
  return 'クラブマッチ';
}

/**
 * 表示 pt をクラブマッチの尺度へそろえる係数（さつき決定 2026-09-12 の (b) 案）。
 * 計算はモードの実払い pt で行い、**表示だけ**この係数を掛ける。モードで pt の桁が変わると
 * 記録一覧の EV ロスが横並び比較できなくなるため。
 * 係数 = クラブの振れ幅(5−(−1)=6) ÷ そのモードの振れ幅。
 */
export function ptDisplayScale(mode: GameMode | undefined): number {
  const p = gameModeSpec(mode).payouts;
  const span = p[0]! - p[p.length - 1]!;
  const clubSpan = GAME_MODE_SPECS.club.payouts[0]! - GAME_MODE_SPECS.club.payouts[5]!;
  return clubSpan / span;
}
