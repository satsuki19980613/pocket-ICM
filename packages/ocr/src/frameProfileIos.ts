/**
 * iOS 用フレームプロファイル（iPhone, 1792×828 クラス, aspect 2.164）。SPEC §6.2 多機種対応。
 *
 * 同一ゲームだが iOS は描画エンジンが異なり要素配置が Android(2730×1260)と非アフィンにずれる
 * （単一コンテンツ矩形/アフィンでは吸収しきれない）。研究の定石どおり **iOS 専用の座標マップ**を
 * 実機スクショから較正して持つ（商用 dickreuter/Poker も別クライアントは別テンプレセットを用意）。
 * iPhone 同士は同一描画で解像度差のみ＝概ねアフィンなので、この 1 プロファイル＋full-frame
 * canonical 正規化（resize.normalizeToCanonical で 2730×1261 へ拡大）で複数モデルを賄える。
 *
 * 実装: **Android の CHIPS_6MAX をアフィン写像**（実測 cr: x'=0.02+0.96x, y'=0.0005+0.959y）
 * したものを土台にし、**発光弧/クリップの残差がある stack 席だけ GT 駆動較正した実測値で上書き**する
 * （scripts/iosBench.ts の STACK_RECT ＝ 実機2枚で trimArcBridge と併せ 12/12 を確認済み）。
 * 席順・意味は CHIPS_6MAX と同一（時計回り [TL,TC,TR,BR,BC,BL]）。
 */

import type { FrameProfile, SeatProfile } from './frameProfile.js';
import { CHIPS_6MAX } from './frameProfile.js';
import type { FracRect } from './layout.js';
import type { FracPoint } from './button.js';

/** 実測アフィン（Android→iOS, full-frame canonical 基準）。 */
const AFF = { ox: 0.02, oy: 0.0005, sx: 0.96, sy: 0.959 } as const;
const fr = (r: FracRect): FracRect => ({ x: AFF.ox + r.x * AFF.sx, y: AFF.oy + r.y * AFF.sy, w: r.w * AFF.sx, h: r.h * AFF.sy });
const pt = (p: FracPoint): FracPoint => ({ x: AFF.ox + p.x * AFF.sx, y: AFF.oy + p.y * AFF.sy });

/** GT 駆動較正した iOS stack 席矩形（iosBench.ts STACK_RECT と一致・実機2枚で確定）。
 * TC/BR/BC/BL は 2/2、TL/TR は trimArcBridge 併用で 2/2。アフィン写像では合わない残差を吸収する。 */
const STACK_RECT: Record<SeatProfile['screen'], FracRect> = {
  TL: { x: 0.232, y: 0.239, w: 0.086, h: 0.036 },
  TC: { x: 0.476, y: 0.139, w: 0.059, h: 0.034 },
  TR: { x: 0.735, y: 0.215, w: 0.072, h: 0.050 },
  BR: { x: 0.784, y: 0.562, w: 0.100, h: 0.038 },
  BC: { x: 0.557, y: 0.683, w: 0.100, h: 0.033 },
  BL: { x: 0.180, y: 0.560, w: 0.061, h: 0.041 },
};

/** hero 手札の較正済み領域（extract は hero 席の card を読む・GT駆動較正で KJo/AQo 2/2）。 */
const HERO_CARD: FracRect = { x: 0.413, y: 0.624, w: 0.101, h: 0.134 };

const seat = (s: SeatProfile): SeatProfile => ({
  ...s,
  stack: STACK_RECT[s.screen], // 実測較正（アフィンでなく直接）
  bet: fr(s.bet),
  betBb: s.betBb ? fr(s.betBb) : undefined,
  // hero 席の card はアフィンだと J→6 誤読が出たため較正値。他席の card 裏(active/folded判定)はアフィン。
  card: s.isHero ? HERO_CARD : fr(s.card),
  actionZone: fr(s.actionZone),
  buttonAnchor: pt(s.buttonAnchor),
});

export const IOS_6MAX: FrameProfile = {
  name: 'ios-6max-1792x828',
  aspect: 1792 / 828,
  blindsNum: fr(CHIPS_6MAX.blindsNum),
  ante: fr(CHIPS_6MAX.ante),
  pot: fr(CHIPS_6MAX.pot),
  board: fr(CHIPS_6MAX.board),
  // heroCards: アフィン写像だと 1 枚で J→6 誤読が出たため GT 駆動較正（実機2枚で KJo/AQo 2/2）。
  heroCards: { x: 0.413, y: 0.624, w: 0.101, h: 0.134 },
  table: fr(CHIPS_6MAX.table),
  seats: CHIPS_6MAX.seats.map(seat),
};
