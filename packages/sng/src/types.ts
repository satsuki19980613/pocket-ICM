/**
 * SIT & GO（会員同士の対人トーナメント）の状態の型。docs/SNG_DESIGN.md §1 の契約。
 *
 * ここは **サーバー（Durable Object）とブラウザの両方**が読む。単位は一貫してチップ
 * （レベル 1 の BB = 200）。表示の bb 換算は画面側だけで行う。
 *
 * `TableState` はサーバーが持つ全情報（デッキ・全員の手札を含む）。クライアントへは
 * `PublicTable`（秘密を落としたもの）と `You`（本人の手札）に分けて送る。
 */

import type { GameMode } from '@oshihiki/core';

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

export const PLAYER_COUNTS = [2, 3, 4, 5, 6] as const;
export type PlayerCount = (typeof PLAYER_COUNTS)[number];

export const START_BBS = [75, 100, 150, 200] as const;
export type StartBb = (typeof START_BBS)[number];

/** ブラインド構造（ゲームに登録されている 3 種）。 */
export const SPEEDS = ['normal', 'slow', 'veryslow'] as const;
export type Speed = (typeof SPEEDS)[number];

export const LEVEL_MINUTES = [3, 4, 5] as const;
export type LevelMinutes = (typeof LEVEL_MINUTES)[number];

/** レベル 1 の BB（チップ）。開始スタックはこれ × startBb。 */
export const BASE_BB = 200;

export interface SngConfig {
  readonly players: PlayerCount;
  readonly startBb: StartBb;
  readonly speed: Speed;
  readonly levelMin: LevelMinutes;
  /** プライズ表（順位 → pt）。core の GAME_MODE_SPECS を引く。 */
  readonly mode: GameMode;
}

// ---------------------------------------------------------------------------
// 時間の定数（ms）
// ---------------------------------------------------------------------------

export const ACTION_MS = 15_000;
export const TIME_BANK_MS = 30_000;
/** 自動処理がこの回数連続したら sitout。 */
export const AUTO_TO_SITOUT = 2;
export const BETWEEN_HANDS_MS = 3_000;
export const WAITING_EXPIRES_MS = 15 * 60_000;
export const PAUSED_EXPIRES_MS = 10 * 60_000;
export const AUTH_TIMEOUT_MS = 5_000;
export const HEARTBEAT_MS = 20_000;

// ---------------------------------------------------------------------------
// 状態
// ---------------------------------------------------------------------------

export type TableStatus = 'waiting' | 'running' | 'paused' | 'finished' | 'cancelled';

/**
 * active … 普通に打っている
 * sitout … 自動処理が続いた／自分で離席。手番が来たら即自動処理。sitin で戻れる
 * left   … 進行中に部屋を出た。sitout と同じ扱いで戻れない
 * out    … 脱落済み（place が入る）
 */
export type PlayerStatus = 'active' | 'sitout' | 'left' | 'out';

export interface PlayerState {
  readonly userId: string;
  /** 表示名（profiles.display_name）。 */
  readonly name: string;
  /**
   * アカウントアイコンの参照（profiles.avatar_url をそのまま持つ）。画像が無い/未設定なら null。
   * 表示側（GlassTable.tsx）はこれを署名 URL に変換してから出す（生の参照のまま <img src> に
   * 入れない）。
   *
   * `?` にしているのは「このフィールドが増える前に DO のストレージへ保存済みの部屋」を
   * 読んだときに実際に undefined になりうるため（`ctx.storage.get<TableState>` は型を
   * 被せるだけで実体を検証しない）。読み出し側は必ず `?? null` で丸めること
   * （worker/sng/table.ts の `normalizeState`・SngTable.tsx/SlumbotTable.tsx の buildSeat 参照）。
   */
  readonly avatarUrl?: string | null;
  /**
   * アバター枠の色（profiles.frame_color。avatarDeco.ts の frame_color と同じ列挙）。
   * `?` にしている理由は `avatarUrl` と同じ（アイコン枠機能より前に保存された部屋には
   * 存在しない。`worker/sng/table.ts` の `normalizeState` が `undefined → null` に丸める）。
   * 読み出し側（GlassTable.tsx の `resolveAvatarDeco`）は null/undefined を steel 扱いにする。
   */
  readonly frameColor?: string | null;
  /** 特別枠（profiles.special_frame）。管理者付与が無ければ null。`avatarUrl` と同じ理由で `?`。 */
  readonly specialFrame?: string | null;
  /** バッジ（profiles.badge）。管理者付与が無ければ null。`avatarUrl` と同じ理由で `?`。 */
  readonly badge?: string | null;
  readonly seat: number;
  readonly stack: number;
  readonly status: PlayerStatus;
  readonly connected: boolean;
  /** 残りタイムバンク。 */
  readonly timeBankMs: number;
  /** 連続した自動処理の回数（手動で動けば 0 に戻る）。 */
  readonly autoCount: number;
  readonly place: number | null;
  readonly pt: number | null;
}

export type ActionKind = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin';

export interface ActionRecord {
  readonly seat: number;
  readonly kind: ActionKind;
  /** そのストリートの「〜まで」の額（fold/check は直前の値のまま）。 */
  readonly betTo: number;
  /** このアクションで新たに出した額。 */
  readonly put: number;
  /** 時間切れ・sitout による自動処理。 */
  readonly auto: boolean;
  /** 0=preflop … 3=river */
  readonly street: number;
}

export type HandPhase = 'betting' | 'showdown' | 'settled';

/** 進行中のハンド。deck と hole は秘密（PublicHand では落とす）。 */
export interface HandState {
  readonly handNo: number;
  readonly level: number;
  readonly sb: number;
  readonly bb: number;
  readonly ante: number;
  /** ボタンの席番号。飛んだ席（dead button）でもよい＝順番を数える基準。 */
  readonly btn: number;
  /** SB を出す席。dead なら null（SB 無し）。 */
  readonly sbSeat: number | null;
  readonly bbSeat: number;
  readonly street: number;
  readonly deck: readonly string[];
  readonly hole: Readonly<Record<number, readonly [string, string]>>;
  readonly board: readonly string[];
  /** 席ごとのハンド開始時スタック（飛んでいる席は 0）。 */
  readonly startStacks: readonly number[];
  /** 席ごとのこのハンドの拠出総額（アンティ・ブラインド込み）。 */
  readonly commits: readonly number[];
  /** 席ごとのこのストリートで出した額。 */
  readonly streetBet: readonly number[];
  readonly folded: readonly boolean[];
  readonly allIn: readonly boolean[];
  /** 次に動く席。-1 なら誰も動かない（ショーダウン待ち・終了）。 */
  readonly toAct: number;
  readonly streetLastBetTo: number;
  /** 直前のベット/レイズの上乗せ幅（最小レイズの基準）。 */
  readonly lastBetSize: number;
  /** 手番の通し番号。act はこれを添える（冪等化）。 */
  readonly actSeq: number;
  readonly actions: readonly ActionRecord[];
  /** 現在の手番の期限（epoch ms）。手番が無ければ null。 */
  readonly deadline: number | null;
  /** ショーダウンで公開した席。 */
  readonly revealed: readonly number[];
  readonly phase: HandPhase;
  /** settled 後の獲得額（席順・Σ = Σcommits）。 */
  readonly won: readonly number[] | null;
  /** このハンドで脱落した席と順位。 */
  readonly eliminated: readonly { readonly seat: number; readonly place: number }[];
}

export interface TableState {
  readonly roomId: string;
  readonly hostId: string;
  readonly config: SngConfig;
  readonly status: TableStatus;
  readonly createdAt: number;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  /** waiting 中は参加順。running 以降は席順（index = seat）。 */
  readonly players: readonly PlayerState[];
  readonly hand: HandState | null;
  /** 配り終えたハンド数（次のハンドは +1）。 */
  readonly handNo: number;
  /** デッドボタン計算用（前のハンドの SB/BB の席）。 */
  readonly prevSbSeat: number | null;
  readonly prevBbSeat: number | null;
  /** 状態が変わるたびに +1。スナップショットの新旧判定。 */
  readonly seq: number;
  /**
   * 次に alarm で起こすべき時刻（epoch ms）と種類。無ければ null。
   * DO はこれをそのまま `setAlarm` に写す（タイマーはここ以外に持たない）。
   */
  readonly wake: { readonly at: number; readonly kind: WakeKind } | null;
}

export type WakeKind =
  | 'action_timeout' // 手番の期限
  | 'next_hand' // ハンド間の間
  | 'waiting_expired' // 募集の期限
  | 'paused_expired'; // 一時停止の期限

// ---------------------------------------------------------------------------
// クライアントへ見せる形
// ---------------------------------------------------------------------------

/** HandState から deck / hole を落とし、公開された手札だけを載せたもの。 */
export type PublicHand = Omit<HandState, 'deck' | 'hole'> & {
  readonly shown: Readonly<Record<number, readonly [string, string]>>;
};

export type PublicTable = Omit<TableState, 'hand' | 'wake'> & {
  readonly hand: PublicHand | null;
};

export interface You {
  readonly userId: string;
  /** 席に着いていなければ null。 */
  readonly seat: number | null;
  /** 進行中ハンドの自分の手札。 */
  readonly hole: readonly [string, string] | null;
}

// ---------------------------------------------------------------------------
// 合法手（画面のボタン出し分け・サーバーの検証で同じ関数を使う）
// ---------------------------------------------------------------------------

export interface LegalActions {
  readonly canFold: boolean;
  readonly canCheck: boolean;
  /** コールで新たに出す額（コールできなければ null）。スタック不足ならその全額。 */
  readonly callPut: number | null;
  /** ベット/レイズできる「〜まで」の下限と上限（できなければ null）。上限 = 自分のオールイン額。 */
  readonly betTo: { readonly min: number; readonly max: number } | null;
  /** まだ誰も張っていない（bet）か、張られている（raise）か。 */
  readonly aggression: 'bet' | 'raise' | null;
}

// ---------------------------------------------------------------------------
// 記録（DB・履歴）
// ---------------------------------------------------------------------------

/** 1 ハンドの記録。`encodeHand` で圧縮表現 v1 にする（docs/SNG_DESIGN.md §4）。 */
export interface SngHandRecord {
  readonly gameId: string;
  readonly handNo: number;
  readonly playedAt: number;
  readonly level: number;
  readonly sb: number;
  readonly bb: number;
  readonly ante: number;
  readonly btn: number;
  readonly sbSeat: number | null;
  readonly bbSeat: number;
  /** 席順のハンド開始時スタック（飛んでいる席は 0）。 */
  readonly startStacks: readonly number[];
  /** ショーダウンで公開された手札だけ。 */
  readonly shown: Readonly<Record<number, readonly [string, string]>>;
  readonly board: readonly string[];
  readonly actions: readonly ActionRecord[];
  readonly won: readonly number[];
  readonly eliminated: readonly { readonly seat: number; readonly place: number }[];
}

/** 試合の結果（sng_games / sng_results に 1 回書く）。 */
export interface SngGameResult {
  readonly gameId: string;
  readonly hostId: string;
  readonly config: SngConfig;
  readonly status: 'finished' | 'cancelled';
  readonly startedAt: number | null;
  readonly endedAt: number;
  readonly hands: number;
  readonly players: readonly {
    readonly userId: string;
    readonly name: string;
    readonly seat: number;
    /** cancelled のときは null。 */
    readonly place: number | null;
    readonly pt: number | null;
  }[];
}
