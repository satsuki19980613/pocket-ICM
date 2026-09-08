/**
 * アンカー方式のアクションタグ探索帯（OCR_PHASE2 §B / §C4 の action 補完）。
 *
 * 本番 extract.ts は各席の紫プレート行動タグ（レイズ/コール/オールイン/チェック）を
 * FrameProfile.actionZone（固定フラクショナル矩形）で読み、spotReconstruction が
 * raise / 非オールインの call（リンプ）/ ウォークを **対象外として棄却**する。アンカー抽出は
 * 従来この能動タグを読まず、chips 過受理に加え「BB 表示だが raise/limp の対象外局面」を
 * 受理してしまっていた（指揮側の 164 枚照合で判明）。本モジュールは席の**名前ボックス**を
 * アンカーに、本番 actionZone と同じ相対位置・寸法の探索帯を作り、recognizeAction を再利用する。
 *
 * 較正: CHIPS_6MAX.actionZone（正規化フレーム＝アンカー正規化画像と同一フラクショナル系）の
 * 中心を、席名中心（seatEnum.SLOT_ANCHORS）からの相対オフセットに直したもの。名前が検出できた
 * 席はその実測名中心にアンカーしてドリフトへ追従し、名前が取れない席は SLOT_ANCHOR 固定値へ
 * フォールバックする（どちらも同一オフセット表＝本番 actionZone と同位置）。
 */

import type { Rect } from './types.js';
import type { Rgba } from './color.js';
import { SLOT_ANCHORS, type Slot } from './seatEnum.js';

/** 席名中心からアクションタグ帯中心へのフラクショナル・オフセット＋帯寸法（CHIPS_6MAX 由来）。 */
interface ActionZoneSpec {
  /** 席名中心からタグ帯中心への x/y オフセット（フラクショナル）。 */
  readonly dx: number;
  readonly dy: number;
  /** 帯の幅・高さ（フラクショナル）。 */
  readonly w: number;
  readonly h: number;
}

/**
 * SLOTS 各席のタグ帯仕様。値は CHIPS_6MAX.actionZone の中心 − SLOT_ANCHORS 中心（フラクショナル）。
 *  TL az(0.15,0.09,0.17,0.065) c(0.235,0.1225)  name(0.268,0.288)
 *  TC az(0.43,0.0 ,0.11,0.075) c(0.485,0.0375)  name(0.522,0.196)
 *  TR az(0.66,0.09,0.17,0.065) c(0.745,0.1225)  name(0.800,0.286)
 *  BR az(0.75,0.45,0.10,0.062) c(0.800,0.481 )  name(0.847,0.644)
 *  BC az(0.35,0.545,0.22,0.06) c(0.460,0.575 )  name(0.620,0.782) hero
 *  BL az(0.09,0.51,0.17,0.06 ) c(0.175,0.540 )  name(0.216,0.642)
 */
export const ACTION_ZONE: Record<Slot, ActionZoneSpec> = {
  TL: { dx: -0.033, dy: -0.166, w: 0.17, h: 0.065 },
  TC: { dx: -0.037, dy: -0.159, w: 0.11, h: 0.075 },
  TR: { dx: -0.055, dy: -0.164, w: 0.17, h: 0.065 },
  BR: { dx: -0.047, dy: -0.163, w: 0.10, h: 0.062 },
  BC: { dx: -0.160, dy: -0.207, w: 0.22, h: 0.06 },
  BL: { dx: -0.041, dy: -0.102, w: 0.17, h: 0.06 },
};

/**
 * 席のアクションタグ探索帯（正規化画像 px）を作る。nameBox（px）があればその中心にアンカーし、
 * 無ければ SLOT_ANCHORS の固定フラクショナル中心を使う（どちらも同一オフセット表）。
 */
export function actionZoneRect(
  img: Rgba,
  slot: Slot,
  nameBox?: { readonly cx: number; readonly cy: number },
): Rect {
  const spec = ACTION_ZONE[slot];
  const baseCx = nameBox ? nameBox.cx : SLOT_ANCHORS[slot].x * img.w;
  const baseCy = nameBox ? nameBox.cy : SLOT_ANCHORS[slot].y * img.h;
  const cx = baseCx + spec.dx * img.w;
  const cy = baseCy + spec.dy * img.h;
  const w = Math.round(spec.w * img.w);
  const h = Math.round(spec.h * img.h);
  return { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h };
}
