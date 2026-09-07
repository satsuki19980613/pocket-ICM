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
