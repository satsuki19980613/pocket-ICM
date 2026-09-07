/**
 * 席の占有（presence）を、スタック数字の**パースとは独立**に判定する。SPEC §6.3 #3 補助。
 *
 * 背景（本バグの根治）: 従来 extract.ts は `occupied = Number.isFinite(stack.value)` と、
 * スタック数字が読めたか**だけ**で占有を決めていた。降りて暗く沈んだ（dimmed）席のスタックが
 * NaN になると、実在する席が empty 扱いになり、6-max が 5-max として黙って解かれる致命傷が出る
 * （positionDerivation は occupied 数を playersLeft にするため席が消える）。
 *
 * そこで「数字が読めるか」に依存しない**陽の占有信号**を足す。実測（scripts/_probeOcc,
 * Android GT 20 枚＋iPhone GT 2 枚, AI 目視ラベル vs 指標）で最も分離が良く機種横断で頑健なのは
 * **スタック矩形のエッジ密度**（前景ストロークの多さ）だった:
 *   - empty（felt 一様, 30 サンプル）: max 0.002
 *   - occupied（全 102 サンプル）    : min 0.089
 *   - occupied だが stack=NaN（142640 BL): 0.199
 *   - iOS occupied（folded 含む）      : min 0.119
 * カード裏の青比 strong は empty 席でも折れたカード裏が 0.311 出て分離できず（機種非頑健）、
 * プレート（actionZone）のエッジ密度は empty 0.018 と iOS hero 0.018 が重なり単独では不可。
 * よって**スタック矩形のエッジ密度を主信号**にし、プレートのエッジ密度を保険で OR する
 * （どちらの閾値も全 empty サンプルの上を通す）。
 *
 * 過学習の注意: iOS は 2 フレーム(12 席)・全 occupied で empty/NaN サンプルが 0。iOS の empty 分離は
 * 実機フィクスチャが無く未検証（Android の empty 30 サンプルで代替検証）。
 */

import type { Gray, Rect } from './types.js';
import type { Rgba } from './color.js';
import { grayFromRgba } from './numberField.js';

/**
 * 席名（プレイヤー名）の**黄色検出**。ディレクタ設計＋別セッションの AI 目視で検証:
 * 非 hero の occupied 席は、プレート色（ピンク/青/暗）や機種（Android/iOS）に依らず
 * **スタックの真下・同一水平中心**に黄色の名前（横書きの連続テキスト）を必ず表示する。
 * empty 席は名前を出さない（黄色画素ゼロ）。hero は例外（金プレート・赤名）だが hero は常在。
 *
 * 実測（scripts/_probeYellow*, Android GT 20枚＋iPhone GT 2枚, AI 目視 vs 指標）:
 *   - empty（30 サンプル）        : 黄色画素 0（yellowRows=0, yellowFrac=0）
 *   - occupied（非 hero, 全機種） : 最弱でも 1 文字名 "k"（114640 BR）で yellowRows≈20
 *   - dimmed folded（114640 BL "sak" / iOS EC7CD106 BR "さつき"）でも黄色は残り検出可
 * 黄色画素テスト（実測レンジ）: R>150 && G>130 && B<120 && |R-G|<70 && R-B>60。
 * 単一画素ノイズと分けるため、**帯内で黄色画素を含む行が minRows 以上連なる**ことを要求する
 * （黄色文字は複数行に跨る連続塊。日本語の細い縦ストロークは水平ランが短いので、水平ランでなく
 *  「黄色を含む行数」で連続性を見る）。
 *
 * ⚠ 注意（過学習・機種非頑健の可能性）: 1 文字名/暗い折れ名は黄色の量が empty 直上まで下がり、
 * 未知解像度でプロファイルがズレると帯を外し **実在席を落とす**危険がある（=6→5 バグ再発）。
 * よって extract.ts では黄色名を**単独主信号にせず**、既存のエッジ密度信号と OR する
 * （エッジ密度は empty max 0.002 vs occupied min 0.089 の 40 倍マージンで頑健）。黄色名は
 * 「そこがプレイヤー席である」ことを意味的に直接示す**追加信号**であり、OR なので席を落とす
 * 方向には決して働かない（empty は黄色 0 なので誤検出も増やさない）。
 */

/** 黄色（席名）画素か。実測レンジ。 */
export function isYellowNamePixel(R: number, G: number, B: number): boolean {
  return R > 150 && G > 130 && B < 120 && Math.abs(R - G) < 70 && R - B > 60;
}

export interface YellowNameOptions {
  /**
   * 名前帯の幅倍率（スタック幅基準, 中心そろえ）。既定 1.8。コーナー席（BR/TR）は名前が
   * 幅広スタック矩形の中心から水平にずれる（実測 dx 最大 ~5.9×名前高）ので広めに取る。
   */
  readonly widthMul?: number;
  /** スタック下端から名前帯上端までの隙間（スタック高基準）。既定 0.1。 */
  readonly gapMul?: number;
  /** 名前帯の高さ倍率（スタック高基準）。既定 1.6。 */
  readonly heightMul?: number;
  /** 「黄色を含む行」とみなす 1 行あたりの最小黄色画素数。既定 2。 */
  readonly minPerRow?: number;
  /** present と判定する最小の黄色行数。既定 4。 */
  readonly minRows?: number;
}

export interface YellowName {
  /** 黄色名を検出したか（黄色行が minRows 以上）。 */
  readonly present: boolean;
  /** 帯内の黄色画素割合 [0,1]（診断用）。 */
  readonly yellowFrac: number;
  /** 黄色を含む行数（診断用）。 */
  readonly yellowRows: number;
}

/**
 * スタック矩形から名前探索帯（真下・同一中心）を導く。
 */
export function nameBandFromStack(stack: Rect, opts: YellowNameOptions = {}): Rect {
  const widthMul = opts.widthMul ?? 1.8;
  const gapMul = opts.gapMul ?? 0.1;
  const heightMul = opts.heightMul ?? 1.6;
  const cx = stack.x + stack.w / 2;
  const w = Math.round(stack.w * widthMul);
  const x = Math.round(cx - w / 2);
  const y = Math.round(stack.y + stack.h + stack.h * gapMul);
  return { x, y, w, h: Math.round(stack.h * heightMul) };
}

/**
 * スタック直下の黄色名を検出する。present = 黄色を含む行が minRows 以上。
 */
export function detectYellowName(img: Rgba, stackRect: Rect, opts: YellowNameOptions = {}): YellowName {
  const minPerRow = opts.minPerRow ?? 2;
  const minRows = opts.minRows ?? 4;
  const band = nameBandFromStack(stackRect, opts);
  const x0 = Math.max(0, band.x);
  const y0 = Math.max(0, band.y);
  const x1 = Math.min(img.w, band.x + band.w);
  const y1 = Math.min(img.h, band.y + band.h);
  const w = Math.max(0, x1 - x0);
  const h = Math.max(0, y1 - y0);
  if (w === 0 || h === 0) return { present: false, yellowFrac: 0, yellowRows: 0 };
  let total = 0;
  let rows = 0;
  for (let y = y0; y < y1; y++) {
    let c = 0;
    for (let x = x0; x < x1; x++) {
      const s = (y * img.w + x) * 4;
      if (isYellowNamePixel(img.data[s]!, img.data[s + 1]!, img.data[s + 2]!)) c++;
    }
    total += c;
    if (c >= minPerRow) rows++;
  }
  return { present: rows >= minRows, yellowFrac: total / (w * h), yellowRows: rows };
}

export interface SeatPresenceOptions {
  /** エッジと見なす勾配（|dx|+|dy|）の下限。既定 40。 */
  readonly edgeThreshold?: number;
  /** スタック矩形のエッジ密度で present とみなす下限。既定 0.04（empty max 0.002 の 20 倍・occupied min 0.089 の下）。 */
  readonly stackFrac?: number;
  /** プレート矩形のエッジ密度で present とみなす下限（保険 OR）。既定 0.06（empty max 0.018 の上）。 */
  readonly plateFrac?: number;
}

export interface SeatPresence {
  /** 占有していると判定したか。 */
  readonly present: boolean;
  /** スタック矩形のエッジ密度 [0,1]。 */
  readonly stackEdge: number;
  /** プレート矩形のエッジ密度 [0,1]。 */
  readonly plateEdge: number;
}

/**
 * グレースケール領域のエッジ密度: 内部画素のうち |左右差|+|上下差| が threshold を超える割合 [0,1]。
 * 一様な felt は≈0、文字/チップ/アバターのある席は高い。割合なので解像度に概ね不変。
 */
export function edgeDensity(g: Gray, threshold = 40): number {
  const { w, h, data } = g;
  if (w < 3 || h < 3) return 0;
  let cnt = 0;
  let tot = 0;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = Math.abs(data[i + 1]! - data[i - 1]!);
      const gy = Math.abs(data[i + w]! - data[i - w]!);
      if (gx + gy > threshold) cnt++;
      tot++;
    }
  return tot ? cnt / tot : 0;
}

/**
 * 席が占有しているかを、スタック数字のパースとは独立に判定する。
 * present = stackEdge >= stackFrac || plateEdge >= plateFrac。
 */
export function detectSeatPresence(
  img: Rgba,
  stackRect: Rect,
  plateRect: Rect,
  opts: SeatPresenceOptions = {},
): SeatPresence {
  const edgeThr = opts.edgeThreshold ?? 40;
  const stackFrac = opts.stackFrac ?? 0.04;
  const plateFrac = opts.plateFrac ?? 0.06;
  const stackEdge = edgeDensity(grayFromRgba(img, stackRect), edgeThr);
  const plateEdge = edgeDensity(grayFromRgba(img, plateRect), edgeThr);
  return { present: stackEdge >= stackFrac || plateEdge >= plateFrac, stackEdge, plateEdge };
}
