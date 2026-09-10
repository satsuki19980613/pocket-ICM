/**
 * アクションマークの探索帯（アスペクト帯 × 席の静的グリッド）。さつき決定 2026-09-10。
 *
 * マークは席のアバター上に出る**固定サイズの吹き出しプレート**で、語の長さに依らず同じ
 * 大きさ（実測 2730×1260 で 0.054×0.042 フラクショナル ＝ 約 148×53 px。「コール」も
 * 「オールイン」も「フォールド」も同幅）。席の位置は画面上で固定なので、**アスペクト帯ごとに
 * フラクショナル座標を実測して持てば**プレートの位置は確定する。
 *
 * ## なぜ席名アンカーではなく静的グリッドか
 * 既存の `anchorAction.ACTION_ZONE` は席名ボックス（黄色名の重心）にアンカーしていた。これは
 * 装飾テーマ卓で壊れる —— 薔薇テーマのフレーム（Screenshot_20260902-203304.png）では黄色の
 * 装飾（薔薇・八角コイン）に重心が引かれ、BR の nameBox が真の名前中心より **0.06h 下**に出て、
 * 帯がプレートを完全に外した（実測）。席名アンカーの静的グリッド `seatAnchorGrids.ts` を
 * 導入したのと同じ理由で、マークの帯も静的グリッドを第一候補にする。
 *
 * ## 較正値の根拠（`scripts/measureMarkGrid.ts` の実測・2026-09-10）
 * 正解ラベル付きの (フレーム, 席) でプレートを実測し、解像度ごとに中央値を採った。
 * 2730×1260 帯（Android 実機・GT 18 例）は席内のばらつきが cx 0.0005〜0.0126 / cy 0.0004〜0.0139。
 * **左右対称性で裏を取った**: (TL+TR)/2 = 0.4810・(BL+BR)/2 = 0.4803・TC = 0.4805 が一致し、
 * どれも卓の中心軸に乗る（測り間違いなら一致しない）。
 * アスペクト 2.163〜2.173 の帯は Android(2730×1260) と iOS 実機(1792×828) で**同じフラクショナル
 * 座標**になることを確認済み（薔薇テーマの TC が 0.4674 / 0.4671、サイズも 0.0505 / 0.0499 と一致）。
 *
 * ## 帯の寸法
 * 詳細は MARK_ZONE_W/H の説明を参照。広めに取り、プレートかどうかの判定は帯の幅ではなく
 * **プレート実寸**を基準に行う（`locateMarkPlate`）。
 *
 * ## グリッドが無いアスペクト帯
 * 未測定の帯は undefined を返し、呼び側は従来の**席名アンカー相対オフセット**（MARK_ZONE）へ
 * 落ちる。既存挙動と同じ経路なので回帰しない。新しい機種で破綻が実測され次第、その帯の
 * グリッドを追加する（`seatAnchorGrids.ts` と同じ運用）。
 */

import type { Rect } from './types.js';
import type { Rgba } from './color.js';
import { SLOT_ANCHORS, type Slot } from './seatEnum.js';

/** マークプレートの中心（フラクショナル）。 */
export type MarkGrid = Partial<Record<Slot, { readonly cx: number; readonly cy: number }>>;

/**
 * 探索帯の寸法（フラクショナル）。プレート実寸 0.054×0.042 の約 2.4 倍。
 *
 * 広めに取る理由: 卓のスキンによって席が内側へ寄る（実測: 薔薇/R.I.P. テーマ卓は標準テーマに
 * 対して TC が 0.013・TR/BR が 0.027 内寄り）。プレート探索（`locateMarkPlate`）は帯の幅では
 * なく**プレート実寸**を基準に枠線を判定するので、帯を広げても判定は緩まない。
 */
export const MARK_ZONE_W = 0.130;
export const MARK_ZONE_H = 0.100;

/**
 * アスペクト 2.163〜2.173 帯（Android 2730×1260 / iOS 実機 1792×828 / iPhone 各 Pro Max 等）。
 * hero(BC) は他席と作りが違い、GT にマーク付きの hero 実例が無いため未登録（帯が無ければ
 * 席名アンカーの相対オフセットへ落ちる）。対応スポットでは hero は手番＝マーク無しなので、
 * ここが空でも下流の判定には効かない。
 */
export const MARK_GRID_2P16: MarkGrid = {
  TL: { cx: 0.2147, cy: 0.1250 },
  TC: { cx: 0.4805, cy: 0.0345 },
  TR: { cx: 0.7473, cy: 0.1250 },
  BR: { cx: 0.7969, cy: 0.4810 },
  BL: { cx: 0.1636, cy: 0.4810 },
};

/** アスペクト比から静的グリッドを選ぶ。未測定帯は undefined（＝席名アンカーへ落ちる）。 */
export function pickMarkGrid(aspect: number): MarkGrid | undefined {
  if (aspect >= 2.15 && aspect <= 2.19) return MARK_GRID_2P16;
  return undefined;
}

/** 席名中心からマーク帯中心への相対オフセット（グリッドが無い帯のフォールバック）。 */
export interface MarkZoneSpec {
  readonly dx: number;
  readonly dy: number;
}

/**
 * 席名中心 → マーク中心の相対オフセット。2730×1260 の実測グリッドと SLOT_ANCHORS の差から算出。
 * 非 hero 席の dy はどれも ≈ -0.16（プレートは席名の 0.16h 上）。
 */
export const MARK_ZONE: Record<Slot, MarkZoneSpec> = {
  TL: { dx: -0.0533, dy: -0.1630 },
  TC: { dx: -0.0415, dy: -0.1615 },
  TR: { dx: -0.0527, dy: -0.1610 },
  BR: { dx: -0.0501, dy: -0.1630 },
  BL: { dx: -0.0524, dy: -0.1610 },
  // hero は席名プレートの作りが違い実例が無い。他席と同じ dy を当てておく（暫定）。
  BC: { dx: -0.1600, dy: -0.1610 },
};

/**
 * 席のマーク探索帯（画像 px）。
 *
 * 優先順:
 *  1. アスペクト帯の静的グリッド（実測・装飾テーマに強い）
 *  2. 検出した席名ボックス ＋ 相対オフセット
 *  3. SLOT_ANCHORS ＋ 相対オフセット（名前が取れない席）
 */
export function markZoneRect(
  img: Rgba,
  slot: Slot,
  nameBox?: { readonly cx: number; readonly cy: number },
  grid?: MarkGrid,
): Rect {
  const g = grid?.[slot];
  let cx: number, cy: number;
  if (g) {
    cx = g.cx * img.w;
    cy = g.cy * img.h;
  } else {
    const spec = MARK_ZONE[slot];
    const baseCx = nameBox ? nameBox.cx : SLOT_ANCHORS[slot].x * img.w;
    const baseCy = nameBox ? nameBox.cy : SLOT_ANCHORS[slot].y * img.h;
    cx = baseCx + spec.dx * img.w;
    cy = baseCy + spec.dy * img.h;
  }
  const w = Math.round(MARK_ZONE_W * img.w);
  const h = Math.round(MARK_ZONE_H * img.h);
  return { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w, h };
}
