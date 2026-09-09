/**
 * OCR パイプラインの共通型（Phase 2）。
 *
 * 設計原則（SPEC §6.1）: OCR は「手入力フォームを埋めるプリフィル」。
 * 各読み取り値は信頼度 [0,1] を伴い、条件確認画面で低信頼を強調する。
 * 生の画像処理（座標較正・テンプレ）は実スクショが要るため後続。ここでは
 * 画像に依存しない純ロジック（ポジション導出・gate・対象外・信頼度）の
 * 入出力契約を定める。
 */

export type AnteScheme = 'all' | 'bb' | 'none';

/** 席が配られているか（occupied）／不在か（empty）。position 導出では empty を除外。 */
export type Occupancy = 'occupied' | 'empty';

/**
 * リプレイ画面が各席に表示する行動ラベル（SPEC §6.3 #3, リプレイ・プリフロップ終了フレーム）。
 * 'none' はラベル未表示（未アクション/読めない）。プリフロップ終了フレームでは
 * 生存席は基本 fold/call/raise/allin/check のいずれかを持つ。
 */
export type SeatAction = 'fold' | 'call' | 'raise' | 'allin' | 'check' | 'none';

/** スタック等の数値表示モード（§6.2）。chips は BB へ正規化して読む。 */
export type DisplayMode = 'bb' | 'chips';

/** 8bit グレースケール画像。行優先、data.length === w*h。 */
export interface Gray {
  readonly w: number;
  readonly h: number;
  readonly data: Uint8Array;
}

/** 画像内の矩形（ピクセル）。 */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** 信頼度付きの読み取り値。conf は [0,1]。 */
export interface Read<T> {
  readonly value: T;
  readonly conf: number;
}

/**
 * 物理席リング上の 1 席（画面上の席）。
 * ring 配列は時計回り（＝プリフロップの行動が進む向き）に並べる。
 * occupied=false は不在・接続切れ（empty）。ボタンは occupied な席にのみ載る。
 */
export interface PhysicalSeat {
  /** 席の識別子（画面席index など）。 */
  readonly id: string;
  /** 生存/フォールド/オールイン等でカードを持つ席か（false=empty）。 */
  readonly occupied: boolean;
  /** この席に D ボタンが載っているか。 */
  readonly isButton: boolean;
  /** hero の席か。 */
  readonly isHero: boolean;
}

/**
 * 画像層が 1 席から読み取った生データ（画像非依存の下流ロジックの入力）。
 * ring 配列は時計回り。金額はすべて BB 換算。
 */
export interface RawSeatRead {
  readonly id: string;
  readonly isHero: boolean;
  readonly isButton: boolean;
  /** 配られている(occupied)／不在(empty)。position 導出では empty のみ除外。 */
  readonly occupancy: Read<Occupancy>;
  /** リプレイの行動ラベル。fold=フォールド, allin=オールイン 等。状態復元の主信号。 */
  readonly action: Read<SeatAction>;
  /** 画面表示スタック（BB 換算, ベット差引後）。 */
  readonly stack: Read<number>;
  /** 席の前に出ているチップ（BB 換算, このストリートの拠出）。 */
  readonly bet: Read<number>;
}

/**
 * 画像層の生読み取り一式（pipeline の入力）。金額はすべて BB 換算済み
 * （chips 表示は抽出層で bb_chips により正規化する）。
 */
export interface RawReads {
  readonly street: Read<string>;
  readonly blinds: { readonly sb: Read<number>; readonly bb: Read<number> };
  readonly ante: { readonly scheme: AnteScheme; readonly amount: Read<number> };
  readonly pot: Read<number>;
  /** hero 手札のハンドクラス表記（例 "A5s"）。 */
  readonly heroHand: Read<string>;
  /** 時計回りの物理席リング（empty 含む, 2..6）。 */
  readonly seats: readonly RawSeatRead[];
  /** 抽出層が判別した数値表示モード（記録・信頼度用, 任意）。 */
  readonly displayMode?: DisplayMode;
  /**
   * 解決した SB/BB/アンティ（**チップ**）＋レベル番号。ヘッダの BB が読めたときに設定される
   * （保存則ベース: 読んだ BB を基準にする）。公式「通常」表にタイト一致すれば level=1..16、
   * 表に無い別スピード（例 480/960/240）は読み値採用で **level=0**。総チップ保存則
   * （場の総 BB = 90,000 ÷ bb）による整合性チェック（chipConsistency）の基準に使う。
   * 未設定＝BB 読めず/非クラブマッチ扱いでチェックは無効（＝従来挙動）。
   */
  readonly blindChips?: { readonly sb: number; readonly bb: number; readonly ante: number; readonly level: number };
}
