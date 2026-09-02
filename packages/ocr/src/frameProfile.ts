/**
 * フレームプロファイル（抽出層の座標モデル）。SPEC §6.2/§6.4。
 *
 * 1 機種・1 レイアウト（6-max, chips 表示, 2730×1260）の全読み取り領域を割合で持つ。
 * 実画像較正済み（各領域の根拠は下のコメント／dev harness の一致数）。座標は利用者
 * スクショから初回較正する前提で、ここに 6-max chips の確定プロファイルを置く。
 *
 * 席は画面位置（TL/TC/TR/BL/BC/BR）で固定。ポジション（D/SB/BB…）は毎ハンド回転するので
 * D ボタン検出（button.ts）で求める。seats は**時計回り**（D 回転で実証: 実データで
 * D=BR→SB=BC→BB=BL, D=TL→SB=TC→BB=TR 等）＝ [TL,TC,TR,BR,BC,BL]。derivePositions のリング順。
 */

import type { FracRect } from './layout.js';
import type { FracPoint } from './button.js';

/** 画面席の識別子（固定位置）。 */
export type ScreenSeat = 'TL' | 'TC' | 'TR' | 'BL' | 'BC' | 'BR';

export interface SeatProfile {
  readonly screen: ScreenSeat;
  /** hero（視点席=BC）か。hero はカード表向き・常に occupied として扱う。 */
  readonly isHero: boolean;
  /** スタック数字領域。 */
  readonly stack: FracRect;
  /** 席前のベット額領域（チップ絵の右の数字）。chips 表示（整数チップ額 "330" 等）用にタイト。 */
  readonly bet: FracRect;
  /**
   * BB 表示専用のベット領域（省略時は bet にフォールバック）。BB 表示は "0.5 BB" のように
   * 先頭が "0." で始まり、chips 用タイト領域だと先頭 "0" が左端で切れて "1" に誤読される
   * （0.5→1.5）。数字の左に少し余白を足した領域を使う。TL/BR は数字が左端で切れないので不要。
   */
  readonly betBb?: FracRect;
  /** カード裏領域（active/folded 判定。hero は表向きなので使わない）。 */
  readonly card: FracRect;
  /** アクションタグ探索帯（アバター上の紫プレート）。 */
  readonly actionZone: FracRect;
  /** D ボタンディスクの席アンカー（button.ts の最近傍割り当て用）。 */
  readonly buttonAnchor: FracPoint;
  /** スタック読みの minCh 上書き（BB 席の宝石飾り除去等）。 */
  readonly stackMinCh?: number;
}

export interface FrameProfile {
  readonly name: string;
  readonly aspect: number;
  /** ブラインド "SB/BB 330/660" の数値部 "330/660"。 */
  readonly blindsNum: FracRect;
  readonly ante: FracRect;
  readonly pot: FracRect;
  /** ストリート判定用の中央ボード領域（カード枚数）。 */
  readonly board: FracRect;
  /** hero 手札の 2 枚を含む帯（findCardRects で分割）。 */
  readonly heroCards: FracRect;
  /** D ボタンディスク探索のテーブル領域。 */
  readonly table: FracRect;
  /** 時計回りの席（6）。derivePositions のリング順。 */
  readonly seats: readonly SeatProfile[];
}

const R = (x: number, y: number, w: number, h: number): FracRect => ({ x, y, w, h });
const P = (x: number, y: number): FracPoint => ({ x, y });

/**
 * 6-max, chips 表示, 2730×1260 の確定プロファイル。
 * stack: numberLayout の CHIPS_6MAX_NUMBER_REGIONS（実画像 85/88）。
 * bet: dev probeBet で 12/12（minCh 既定, チップ絵を避け数字部にタイト化）。
 * card: cardState probeCardState で active/folded 8/8（BL は 142820 で確認）。
 * buttonAnchor: button.ts probeButton で D 席 11/11。
 * actionZone: actionTag（能動4語）。※ 6 席帯は較正途上（特に BR はスタック近接に注意）。
 */
export const CHIPS_6MAX: FrameProfile = {
  name: 'chips-6max-2730x1260',
  aspect: 2730 / 1260,
  blindsNum: R(0.172, 0.012, 0.084, 0.044),
  ante: R(0.18, 0.058, 0.06, 0.04),
  pot: R(0.50, 0.315, 0.09, 0.048),
  board: R(0.30, 0.34, 0.40, 0.22),
  heroCards: R(0.425, 0.655, 0.105, 0.150),
  table: R(0.05, 0.12, 0.90, 0.68),
  seats: [
    {
      screen: 'TL', isHero: false,
      stack: R(0.221, 0.249, 0.09, 0.038), bet: R(0.315, 0.335, 0.075, 0.044),
      card: R(0.235, 0.13, 0.075, 0.085), actionZone: R(0.15, 0.09, 0.17, 0.065),
      buttonAnchor: P(0.349, 0.276),
    },
    {
      screen: 'TC', isHero: false,
      stack: R(0.491, 0.151, 0.061, 0.041), bet: R(0.487, 0.243, 0.08, 0.044),
      betBb: R(0.479, 0.243, 0.088, 0.044),
      // actionZone: TC タグは頭上の紫プレート（frac x0.449 y0.013 w0.060 h0.055）。
      // 旧 y0.03/h0.065 は下のワイド装飾ネームプレートを併合し 367px 箱になっていた。
      // タグだけを含む短い帯に（y0 起点, 高さ 0.075, ネームプレートは y0.10+ なので除外）。
      card: R(0.50, 0.09, 0.075, 0.085), actionZone: R(0.43, 0.0, 0.11, 0.075),
      buttonAnchor: P(0.569, 0.266),
    },
    {
      screen: 'TR', isHero: false,
      stack: R(0.766, 0.249, 0.085, 0.04), bet: R(0.665, 0.335, 0.066, 0.048),
      betBb: R(0.657, 0.335, 0.074, 0.048),
      card: R(0.775, 0.13, 0.075, 0.085), actionZone: R(0.66, 0.09, 0.17, 0.065),
      buttonAnchor: P(0.692, 0.276),
    },
    {
      screen: 'BR', isHero: false,
      stack: R(0.811, 0.601, 0.115, 0.04), bet: R(0.699, 0.47, 0.062, 0.05),
      // actionZone: BR タグ frac x0.766 y0.460 w0.062 h0.048。旧 y0.435/h0.058 は
      // タグ下部をクリップし h42 の歪んだ箱になっていた。y を下げ全高を含める。
      card: R(0.835, 0.49, 0.085, 0.085), actionZone: R(0.75, 0.45, 0.10, 0.062),
      buttonAnchor: P(0.746, 0.549),
    },
    {
      screen: 'BC', isHero: true,
      stack: R(0.575, 0.715, 0.115, 0.045), bet: R(0.516, 0.592, 0.066, 0.05),
      betBb: R(0.508, 0.592, 0.074, 0.05),
      card: R(0.425, 0.655, 0.105, 0.150), actionZone: R(0.35, 0.545, 0.22, 0.06),
      buttonAnchor: P(0.603, 0.623),
    },
    {
      screen: 'BL', isHero: false,
      stack: R(0.191, 0.594, 0.065, 0.036), bet: R(0.303, 0.466, 0.066, 0.05),
      betBb: R(0.295, 0.466, 0.074, 0.05),
      card: R(0.21, 0.52, 0.075, 0.08), actionZone: R(0.09, 0.51, 0.17, 0.06),
      buttonAnchor: P(0.285, 0.549), stackMinCh: 168,
    },
  ],
};
