/**
 * アンカー抽出（画像 → RawReads, OCR_PHASE2 §B1）。本番未接続の Phase 2b。
 *
 * 固定座標プロファイルを使わず、ランドマーク（黄色名・"BB" グリフ・D ディスク・中央ピル）からの
 * 相対読みで RawReads を組み立てる。返す形は extract.ts の extractRawReads と同一で、下流の
 * runOcrPipeline（spotReconstruction → positionDerivation → BoardState）をそのまま再利用する
 * （クリーンな境界: 抽出だけ差し替え、下流は不変）。
 *
 * パイプライン（§B1）:
 *   normalizeForAnchors（§B2 拡大正規化）
 *   → enumerateSeats（§B3 席列挙: 6 スロットの占有＋黄色名ボックス＋hero）
 *   → 各占有席: 名前直上の "N.N BB" を readAmountBbAnchored で読む（§B4 stack）
 *   → 中央 "Pot :" ピルを readPotAnchored で読む（§B5 pot）
 *   → 左上ヘッダの SB/BB・アンティ（readBlinds, chips → BB 正規化）
 *   → D ディスク → 最近傍占有席 = ボタン（§B6）
 *   → hero カード帯の 2 枚 → heroHand（recognizeHeroHandColor）
 *   → displayMode: stack が "BB" 終端か（§B7, stackEndsWithBb/detectDisplayMode）
 *
 * 席は SLOTS 順 [TL,TC,TR,BR,BC,BL]（時計回り, derivePositions のリング順）で返す。id は
 * スロット名（GT / accuracy の SeatId と一致）。金額はすべて BB 換算（BB 表示は既に BB、chips は
 * ヘッダ bb で正規化）。
 *
 * bet 読み（fix 1/2, readBetAnchored）: 席前チップ "N BB" を BB アンカーで読む。bet=0 固定だと下流
 * spotReconstruction が SB/BB の投函分（putIn=blindOb）を失い root が SB −0.5 / BB −1.0 ずれ、allin は
 * root が潰れる。**ポジションは決め打ちせず実チップを読み**（§B1 の設計原則）、下流が blindOb で相殺する。
 * チップ無し・folded 席は読まず bet=0（幻レイズ棄却を回避, §B8）。
 *
 * stack 読み（fix 3）: 名前直上 BB アンカーを主とし、名前ボックス検出が破綻した席（手番グロー枠 hero /
 * 折れ暗コーナー / iOS 小名）は固定フラクショナル y の数字ライン（STACK_Y_FRAC）で読み直す。
 *
 * action: **`AnchorTemplates.marks` を渡すのが本番経路**（アプリは常に渡す。2026-09-10 以降）。
 * 行動した席には必ず吹き出しプレート（フォールド/コール/レイズ/オールイン/チェック）が出るので、
 * `actionMark.recognizeMark` でそれを読んで action を確定し、**マークが無ければ未行動 = none** と
 * 言い切る。カード裏の色（cardState）は使わない —— カード裏はユーザーが着せ替えられ、淡色スキンの
 * 実機フレームで全席が fold と誤判定された（docs/OCR_PHASE2.md §C5）。hero も同じ経路で読む。
 * これは固定座標経路（extract.ts）とは**異なる**（あちらは従来どおり cardState ＋ 能動タグ）。
 *
 * `marks` 未指定時は従来経路を温存する（回帰ゼロのため）: 非 hero は fold（isActiveHand）→ active なら
 * 能動タグ NCC（recognizeAction; raise/call/allin/check）、hero も能動タグ、タグが none の非 hero で
 * stack≈0 なら allin ヒューリスティックで補完。どちらの経路でも raise/limp/walk の対象外局面は
 * 下流 spotReconstruction が棄却する（§6.5）。
 */

import type { AnteScheme, DisplayMode, Occupancy, RawReads, RawSeatRead, Read, Rect, SeatAction } from './types.js';
import type { Rgba } from './color.js';
import type { Template } from './match.js';
import { normalizeForAnchors } from './upscaleNormalize.js';
import { enumerateSeats, SLOTS, type SeatSlot, type Slot } from './seatEnum.js';
import { readAmountBbAnchored } from './bbAmount.js';
import { recognizeAction } from './actionTag.js';
import { recognizeMark } from './actionMark.js';
import { markZoneRect, pickMarkGrid } from './actionMarkZone.js';
import { actionZoneRect } from './anchorAction.js';
import { readBlinds } from './blinds.js';
import { readPotAnchored, type PotAnchorRegion } from './potAnchor.js';
import { goldDiscCandidates, type FracPoint } from './button.js';
import { isActiveHand, blueFractions, pickHandActiveRule, type CardStateOptions } from './cardState.js';
import { recognizeAmount, grayFromRgba } from './numberField.js';
import { findCardRects, largestCardRects } from './detect.js';
import { recognizeHeroHandColor } from './cards.js';
import type { HandActiveRule } from './frameProfile.js';
import { resolveBlindChips } from './blindLevels.js';

export interface AnchorTemplates {
  readonly digits: readonly Template[];
  readonly ranks: readonly Template[];
  /** BB 接尾辞・モード判定の "B"。省略時はモード判定できず chips 既定になる。 */
  readonly letters?: readonly Template[];
  /**
   * 能動アクション語（レイズ/コール/オールイン/チェック）。省略時は能動タグを読まず、
   * fold(cardState) ＋ allin ヒューリスティックのみ（従来挙動）。渡すと本番 extract 同様に
   * 席のタグを読み、raise/limp/walk を下流 spotReconstruction が対象外棄却できる（§B/§6.5）。
   */
  readonly actions?: readonly Template[];
  /**
   * アクションマークの語（フォールド/レイズ/コール/オールイン/チェック, `assets/action_marks.json`）。
   *
   * **渡すとこれが action の主信号になる**（`actionMark.recognizeMark`）。行動した席には必ず
   * 吹き出しプレートが出るので、マークが無い席は「まだ行動していない」＝ none と確定できる。
   * 省略時は従来経路（カード裏の色で fold 判定 ＋ 能動タグ ＋ allin ヒューリスティック）。
   */
  readonly marks?: readonly Template[];
}

export interface AnchorOptions {
  readonly displayMode?: DisplayMode;
  readonly anteScheme?: AnteScheme;
  /** カード裏 active/folded 判定ルール（機種依存）。省略時 cardState 既定（Android bright/0.06）。 */
  readonly handActive?: HandActiveRule;
  /** pot 中央帯（正規化画像に対するフラクショナル, 省略時 DEFAULT_POT_REGION）。 */
  readonly potRegion?: PotAnchorRegion;
  /** BB 読みの scoreFloor（既定 0.45, stack の飾り片除去）。 */
  readonly scoreFloor?: number;
  /**
   * 機種別・席名中心の静的グリッド（フラクショナル）。指定した席は、検出した黄色名重心の
   * 代わりにこの座標で nameBox 中心を確定する（装飾混入で重心が名前中心を外す機種の是正,
   * seatAnchorGrids.ts）。占有席のみ適用（空席は不変）。undefined の席・未指定時は現行の
   * 検出重心のまま（＝回帰ゼロ）。
   */
  readonly seatAnchors?: Partial<Record<Slot, { readonly x: number; readonly y: number }>>;
}

/** 左上ヘッダのブラインド数値部 "330/660"（フラクショナル）。CHIPS_6MAX 較正値を流用。 */
const HEADER_BLINDS: Rect = { x: 0.172, y: 0.012, w: 0.084, h: 0.044 };
/** 左上ヘッダのアンティ（フラクショナル）。CHIPS_6MAX 較正値を流用。 */
const HEADER_ANTE: Rect = { x: 0.18, y: 0.058, w: 0.06, h: 0.04 };
/** hero カード帯（フラクショナル）。2 枚の表向きカードを内包する高さを確保（_dbg2 で全機種一致）。 */
const HERO_CARD_BAND = { x: 0.40, y: 0.62, w: 0.22, h: 0.20 };

/**
 * D ボタンディスクの席アンカー（フラクショナル）。ディスクは名前プレートより内側（テーブル中心寄り）に
 * 載るため、名前中心ではなくディスク位置に較正したアンカーを使う（CHIPS_6MAX.buttonAnchor と同値。
 * 実測で Android/iOS のディスク重心がこの位置に落ちる — _dbg2）。SLOTS 順。
 */
const BUTTON_ANCHORS: readonly FracPoint[] = [
  { x: 0.349, y: 0.276 }, // TL
  { x: 0.569, y: 0.266 }, // TC
  { x: 0.692, y: 0.276 }, // TR
  { x: 0.746, y: 0.549 }, // BR
  { x: 0.603, y: 0.623 }, // BC (hero)
  { x: 0.285, y: 0.549 }, // BL
];

const BB_SCORE_FLOOR = 0.45;

/**
 * whiteMask の minCh を段階的に上げて BB スタックを読む。席プレートの背景明度・ホログラム飾りの
 * 強さが席／機種で異なり単一 minCh では両立しない（実測: BL・iOS TL は 168 が必要, TC/TR は 120 で
 * ないと NaN, 150 は sparkle 混入で **高信頼の誤読** を出す罠）。順序 [120,168,185,150] で最初に
 * 有限値になったものを採る（120 で正読できる席はそのまま＝回帰なし。120 が NaN の席だけ 168→185 と
 * 上げ、罠の 150 は最後）。scoreFloor で飾り片を桁から除外（§B4）。
 *
 * iOS 下段（BR/BC）・hero の手番グロー枠等でグリフ明度が沈む席向けに、より低い minCh（96/80）も
 * 末尾に足す（120 で NaN の席だけ降段。上段の順序は不変＝回帰なし）。低 minCh は felt/隣接の弱い
 * 白を拾いやすいが scoreFloor＋BB アンカー（直左数字を持つ BB のみ）が偽桁を除外する。
 */
const MINCH_SEQ = [120, 168, 185, 150, 96, 80] as const;
function readStackAnchored(
  img: Rgba,
  sr: Rect,
  cx: number,
  digits: readonly Template[],
  letters: readonly Template[] | undefined,
  scoreFloor: number,
): Read<number> {
  for (const minCh of MINCH_SEQ) {
    const r = readAmountBbAnchored(img, sr, digits, { scoreFloor, minCh }, letters, cx);
    if (Number.isFinite(r.value)) return r;
  }
  return { value: NaN, conf: 0 };
}

/**
 * 席前のベット・チップ "N BB" を **BB アンカー**で読む（§B1 の bet 読み・fix 1/2）。
 *
 * 動機: bet=0 固定だと、下流 spotReconstruction が `rootStack = screenStack + putIn(=bet) - blindOb`
 * で SB/BB の投函分（putIn=blindOb）を失い、SB は −0.5・BB は −1.0 だけ root がずれる（実測: 全 27 枚で
 * 系統オフセット）。allin 席は screenStack≈0＋大きいベット（例 5.9 BB）なので、bet を読まないと
 * root が潰れる（123636 SB 5.4→0.5, 115309 BU 9.6→1）。**ポジションはこの段では未知**なのでブラインドを
 * 決め打ちできず、実チップを読む（§B1 の設計原則: 実チップを読み、下流が blindOb で相殺する）。
 *
 * チップは席（名前）とテーブル中心の間に載る。名前ボックス中心から**中心方向へ**較正オフセット
 * （BET_OFFSETS, CHIPS_6MAX の betBb 中心 − 席名中心の実測差）だけ寄せた点を bet 中心とし、その周りの
 * 小矩形を readAmountBbAnchored（直左に数字を持つ BB のみ・アンカー最近傍を採る）にかける。チップが
 * 無い席（フォールド・非ブラインド）は "N BB" が無く NaN → bet=0（幻レイズ棄却を避ける, §B8）。
 */
const BET_OFFSETS: Record<Slot, { dx: number; dy: number }> = {
  TL: { dx: 0.085, dy: 0.069 },
  TC: { dx: 0.001, dy: 0.069 },
  TR: { dx: -0.106, dy: 0.073 },
  BR: { dx: -0.117, dy: -0.149 },
  BC: { dx: -0.075, dy: -0.165 },
  BL: { dx: 0.116, dy: -0.151 },
};

/** 名前ボックス（px）と席スロットから、席前ベット "N BB" 探索用の矩形＋アンカー x を作る。 */
function betRectFromName(
  img: Rgba,
  slot: Slot,
  nb: { cx: number; cy: number; h: number },
): { rect: Rect; cx: number } {
  const off = BET_OFFSETS[slot];
  const bx = nb.cx + off.dx * img.w;
  const by = nb.cy + off.dy * img.h;
  const h = Math.max(6, nb.h);
  const sh = Math.round(1.4 * h);
  const sw = Math.round(3.2 * h); // タイト（readAmountBbAnchored が更に左右へ拡張。中央 pot 帯を避ける）
  return {
    rect: { x: Math.round(bx - sw / 2), y: Math.round(by - sh / 2), w: sw, h: sh },
    cx: bx,
  };
}

/** 席前ベット "N BB" を読む（minCh 昇段。チップ無し→NaN）。 */
function readBetAnchored(
  img: Rgba,
  slot: Slot,
  nb: { cx: number; cy: number; h: number },
  digits: readonly Template[],
  letters: readonly Template[] | undefined,
  scoreFloor: number,
): Read<number> {
  const { rect, cx } = betRectFromName(img, slot, nb);
  return readStackAnchored(img, rect, cx, digits, letters, scoreFloor);
}

/**
 * 席スタック**数字ライン**のフラクショナル y（SLOTS 順）。名前ボックス検出が破綻した席（手番グロー枠で
 * 名前が checkered プレートに埋もれ黄色塊が寸断 → nb.top/h/cx が不正）のフォールバックで、数字帯を
 * **固定フラクショナル y** に置いて探す（名前の悪い top に依らない）。値は Android/iOS 双方で数字が
 * 収まる**数字ライン**（実測 sweep: BR 0.596・BC 0.70 で Android 203304 と iOS 2 機を同時に正読）。
 * iOS は Android 較正から affine（y'≈0.0005+0.959y）で上へずれるため、下段席は Android の矩形中心
 * より高い位置になる。x は検出できた nb.cx を使う（水平は概ね安定, リーダが左右へ拡張して数字塊を捕捉）。
 * 上段席（TL/TC/TR）・BL は本 27＋1310 でフォールバックが発火しない（名前検出が安定）が、汎用性の
 * ため iOS affine 補正した数字ラインを置く（発火してもリーダ内部拡張と scoreFloor が過読を抑える）。
 */
const STACK_Y_FRAC: Record<Slot, number> = {
  TL: 0.262, TC: 0.166, TR: 0.263, BR: 0.596, BC: 0.70, BL: 0.60,
};

const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

const fracRect = (img: Rgba, f: Rect): Rect => ({
  x: Math.round(f.x * img.w),
  y: Math.round(f.y * img.h),
  w: Math.round(f.w * img.w),
  h: Math.round(f.h * img.h),
});

const norm = (r: Read<number>, bb: number): Read<number> =>
  bb > 0 && Number.isFinite(r.value) ? { value: r.value / bb, conf: r.conf } : { value: r.value, conf: r.conf };

/** SB<BB の不変条件を守る（extract.sanitizeBlinds と同義）。 */
function sanitizeBlinds(sb: Read<number>, bb: Read<number>): { sb: Read<number>; bb: Read<number> } {
  if (Number.isFinite(bb.value) && bb.value > 0) {
    const bad = !Number.isFinite(sb.value) || sb.value <= 0 || sb.value >= bb.value;
    if (bad) return { sb: { value: bb.value / 2, conf: Math.min(sb.conf, 0.3) }, bb };
  }
  return { sb, bb };
}

/**
 * 名前ボックス（正規化画像 px）から、その直上のスタック "N.N BB" 探索用の矩形を作る。
 * スタックは名前の直上・ほぼ同一水平中心（コーナー席は多少ずれるが readAmountBbAnchored が
 * 左右へ広げて吸収する）。矩形寸法は名前高 h を基準にする（グリフ高≒名前高, §B4）。
 */
function stackRectFromName(nb: { cx: number; top: number; h: number }): Rect {
  const h = Math.max(6, nb.h);
  const sh = Math.round(1.4 * h); // スタック行（BB 込み）の高さ
  const sw = Math.round(4.5 * h); // 中心寄せの数字幅（readAmountBbAnchored が更に左右へ拡張）
  const gap = Math.round(0.15 * h);
  return {
    x: Math.round(nb.cx - sw / 2),
    y: Math.round(nb.top - gap - sh),
    w: sw,
    h: sh,
  };
}

/**
 * 名前ボックス破綻席のフォールバック stack 帯（固定フラクショナル y ＋検出 nb.cx）。名前検出が寸断され
 * nb.top が数字帯を外す席（手番グロー席 hero BC / 折れ暗コーナー BR / iOS 小名 BR・BC）向け。帯を高く
 * （3.2×robustH）取り、機種の affine ずれと nb.top 誤差を吸収する。robustH は席の nameBox 高の中央値。
 */
function stackFallbackRect(img: Rgba, slot: Slot, nbCx: number, hRobust: number): Rect {
  const h = Math.max(8, hRobust);
  const sh = Math.round(2.2 * h); // 過剰に高いとアバター/グローを取り込み glyphH 較正が狂い誤読（実測 sweep）
  const sw = Math.round(5.0 * h);
  const cy = STACK_Y_FRAC[slot] * img.h;
  return { x: Math.round(nbCx - sw / 2), y: Math.round(cy - sh / 2), w: sw, h: sh };
}

/**
 * 非 hero 席のカード裏領域（名前ボックスから導出、fold 判定 isActiveHand に渡す）。名前直上の
 * スタック帯の更に上（アバター帯）に載る。プリパス（blueFractions 収集）と本読みで同一の矩形を
 * 使うため関数化（cardRect のロジック自体は変更しない）。
 */
function cardRectFromName(nb: { cx: number; top: number; h: number }): Rect {
  const h = Math.max(6, nb.h);
  return {
    x: Math.round(nb.cx - 1.6 * h),
    y: Math.round(nb.top - 6.0 * h),
    w: Math.round(3.2 * h),
    h: Math.round(3.6 * h),
  };
}

/**
 * hero カード検出の明度しきい値。厳しい順に試し、2 枚揃った最初の値を採る。
 *
 * 190 は無地の緑フェルト（較正機）向け。装飾テーマの卓では hero カードの隣に淡色の
 * キャラ絵が載り、カードの白塊とキャラ絵が 1 つに繋がって横長になり、縦横比フィルタ
 * [0.45,0.95] で「カードではない」と捨てられる（実測: Pixel 実機フレームで
 * 249×194・比 1.284 の塊になり J♣ が消え、10♣ の 1 枚だけになって手札が空）。
 * カード面はほぼ純白・キャラ絵は少し暗いので、しきい値を上げれば分離できる
 * （225 で JTs を正しく復元・較正機 J4o/QJs/AQs は 190 と同一）。
 *
 * 厳しい方を先に試し、2 枚揃わなければ従来の 190 へ落とす。これにより
 * 「225 では暗くて消えるフレーム」でも現行挙動が保たれる（回帰ゼロを構造で担保）。
 */
const HERO_CARD_THRESHOLDS = [225, 190] as const;

/** hero(BC) の 2 枚を検出して heroHand を読む。 */
function readHeroHand(img: Rgba, ranks: readonly Template[]): Read<string> {
  const hrect = fracRect(img, HERO_CARD_BAND);
  const g = grayFromRgba(img, hrect);
  for (const threshold of HERO_CARD_THRESHOLDS) {
    const found = findCardRects(g, { threshold, minAreaFrac: 0.02, closeRadius: 1 }).map((r) => ({
      x: hrect.x + r.x,
      y: hrect.y + r.y,
      w: r.w,
      h: r.h,
    }));
    const rects = largestCardRects(found, 2);
    if (rects.length >= 2) return recognizeHeroHandColor(img, rects[0]!, rects[1]!, ranks);
  }
  return { value: '', conf: 0 };
}

/**
 * アンカー抽出のメイン。img は任意解像度／アスペクト。RawReads（extractRawReads と同形）を返す。
 */
export function extractAnchored(img: Rgba, templates: AnchorTemplates, opts: AnchorOptions = {}): RawReads {
  const { digits, ranks, letters, actions, marks } = templates;
  const scoreFloor = opts.scoreFloor ?? BB_SCORE_FLOOR;

  // §B2/§B3: 正規化してから席列挙。normalizeForAnchors は決定的なので enumerateSeats が内部で
  // 使う正規化画像と同一（nameBox はこの正規化画像座標）。
  const { img: nimg } = normalizeForAnchors(img);
  const enr = enumerateSeats(img);
  // マーク帯の静的グリッド（アスペクト帯ごとの実測値。未測定帯は undefined で席名アンカーに落ちる）。
  const markGrid = pickMarkGrid(img.w / img.h);

  // ロバストな名前高（占有席 nameBox 高の中央値）。手番グロー席・iOS 小名で個々の nb.h が過小に
  // 出るため、フォールバック stack 帯の尺度に使う（個々の壊れた nb.h に依存させない）。
  const robustNameH = median(enr.seats.filter((s) => s.occupied).map((s) => s.nameBox?.h ?? 0).filter((h) => h > 0)) || 20;

  // 機種別静的グリッド（seatAnchors）が指定された占有席は、検出重心の代わりにグリッド座標で
  // nameBox 中心を確定する（装飾混入で重心が名前中心を外す機種の是正）。高さは robustNameH で
  // 統一（汚染された個別 nb.h に依存しない）。未指定席・空席は検出結果のまま＝回帰ゼロ。
  const seatsAdj: readonly SeatSlot[] = opts.seatAnchors
    ? enr.seats.map((s) => {
        const g = opts.seatAnchors![s.slot];
        if (!s.occupied || !g) return s;
        const cx = g.x * nimg.w;
        const cy = g.y * nimg.h;
        const h = robustNameH;
        return { ...s, nameBox: { cx, cy, top: cy - h / 2, bottom: cy + h / 2, h } };
      })
    : enr.seats;
  const occ = seatsAdj.filter((s) => s.occupied);

  // 各占有席のスタック探索矩形（名前ボックスから導出）。nameBox が無い占有席（黄色名を外した
  // 席）は矩形を作れず stack=NaN のまま（occupancy は保持＝席は落とさない）。
  const stackRectOf = (s: SeatSlot): Rect | null =>
    s.nameBox ? stackRectFromName(s.nameBox) : null;

  // §B7: 表示モード判定。名前直上のタイト帯を **BB アンカーリーダ**（readAmountBbAnchored）に
  // かけ、**直左に数字塊を持つ BB トークン**が取れれば bb（chips 表示のスタックは純数字・カンマで
  // "BB" 接尾辞が無く、名前直上のタイト帯には BB トークンが生じない）。占有席の **OR 投票**で
  // 「1 席でも BB 読取が有限なら bb」とする。
  //
  // 旧実装との差（過受理の是正）: 旧コードは readStackAnchored の **minCh 段階昇段**
  // ([120,168,185,150,96,80]) で読み、低 minCh(96/80) と罠の 150 が chips スタックの felt/縁
  // ノイズを BB に化けさせ、chips 表示を bb と誤判定して**生チップ額を BB として過受理**していた
  // （指揮側 164 枚照合で 25 枚の危険な過受理）。モード判定は**単一の保守的な minCh=120 のみ**で
  // 読む（昇段しない）——実測で chips スタックはこの minCh では BB アンカーが有限値を返さず（NaN）、
  // BB スタックは iOS/Android とも ≥1 席が有限になる。stackEndsWithBb（末尾 2 tall = B ペア）は
  // iOS 低解像度で系統的に false になり BB 局面を取りこぼした（アンカーリーダの弧較正/探索の方が頑健）。
  let mode: DisplayMode = opts.displayMode ?? 'chips';
  if (opts.displayMode === undefined && letters) {
    for (const s of occ) {
      const sr = stackRectOf(s);
      if (!sr || !s.nameBox) continue;
      const r = readAmountBbAnchored(nimg, sr, digits, { scoreFloor, minCh: 120 }, letters, s.nameBox.cx);
      if (Number.isFinite(r.value)) { mode = 'bb'; break; }
    }
  }

  // ヘッダ SB/BB・アンティ（常に chips 表記）→ bb で BB 正規化。
  const blindsRaw = readBlinds(nimg, fracRect(nimg, HEADER_BLINDS), digits);
  const bbChips = Number.isFinite(blindsRaw.bb.value) && blindsRaw.bb.value > 0 ? blindsRaw.bb.value : 1;
  const bbNorm = norm(blindsRaw.bb, bbChips).value; // BB 換算での BB（=1, allin bet の下駄に使う）。
  const anteChips = recognizeAmount(nimg, fracRect(nimg, HEADER_ANTE), digits);
  // ブラインド解決（クラブマッチ・保存則ベース）。読んだ BB を基準に blindChips を露出し、下流の総チップ
  // 保存チェック（chipConsistency）の基準にする。公式「通常」表にタイト一致すれば厳密値で小誤読を補正、
  // 一致しない別スピード（例 480/960/240）は読み値をそのまま採用（960 を 1100 へ誤スナップしない）。
  // 既存の正規化（bbChips）は変えない＝スタック/ポットの値は不変（回帰ゼロ）。
  // **BB 表示モード限定**: chips 表示はヘッダの数値が別物で BB がゴミ値に化けうる（実測 88106）ため、
  // 解決すると誤ってブラインドを 0.5/1.0 へ上書きし reconstruction を壊す。chips は取り込み対象外
  // （§5.2 で棄却）なので rb=null＝従来の sanitizeBlinds のまま（回帰ゼロ）。BB が読めなければ null。
  const rb = mode === 'bb' ? resolveBlindChips(blindsRaw.sb.value, blindsRaw.bb.value, anteChips.value) : null;

  // pot（§B5）: BB 表示は中央ピルを BB アンカーで、chips は中央矩形の生読み→正規化。
  let pot: Read<number>;
  if (mode === 'bb') {
    let p = readPotAnchored(nimg, digits, letters, { scoreFloor: 0 }, opts.potRegion);
    // タイト帯で読めない稀なフレーム（実測 143002: ピル数字がにじむ）は広い帯で再挑戦。値がずれても
    // 有限にして棄却を避ける（下流の zod は pot に finite を要求, 精度は confidence で下げる）。
    if (!Number.isFinite(p.value) && !opts.potRegion) {
      p = readPotAnchored(nimg, digits, letters, { scoreFloor: 0 }, { x: 0.42, y: 0.29, w: 0.17, h: 0.08 });
    }
    pot = { value: p.value, conf: p.conf };
  } else {
    const potRect = fracRect(nimg, { x: 0.46, y: 0.305, w: 0.11, h: 0.05 });
    pot = norm(recognizeAmount(nimg, potRect, digits), bbChips);
  }

  // D ボタン: テーブル領域内の金ディスク → 占有席の名前アンカー最近傍。
  // 席アンカーは各占有席の nameBox 中心（フラクショナル）。空席はアンカーに含めない。
  const table: Rect = {
    x: Math.round(0.05 * nimg.w),
    y: Math.round(0.12 * nimg.h),
    w: Math.round(0.90 * nimg.w),
    h: Math.round(0.68 * nimg.h),
  };
  // ボタン: テーブル領域のゴールドディスク候補のうち、いずれかの席アンカー近傍（<=0.10）に
  // 落ちるものから **最大面積** を選ぶ。実 D ディスクは大きく（area ~680–1030）、席プレートの
  // 金枠飾りは小さい（~440）。detectButtonSeat の「最近傍」では、複数席に近い金飾りがあると
  // 実ディスクより僅かに近い飾りを拾う（実 iPhone EC7CD106 で TL の D を TR 飾りが奪う）ため、
  // 近傍かつ最大面積で選ぶ。
  const MAX_ANCHOR_DIST = 0.10;
  let button: { slot: (typeof SLOTS)[number]; area: number } | undefined;
  for (const c of goldDiscCandidates(nimg, table)) {
    let ni = -1, nd = Infinity;
    for (let i = 0; i < BUTTON_ANCHORS.length; i++) {
      const a = BUTTON_ANCHORS[i]!;
      const d = Math.hypot(a.x - c.cx, a.y - c.cy);
      if (d < nd) { nd = d; ni = i; }
    }
    if (nd > MAX_ANCHOR_DIST || ni < 0) continue;
    if (!button || c.area > button.area) button = { slot: SLOTS[ni]!, area: c.area };
  }
  const buttonSlot = button?.slot;

  // hero 手札。
  const heroHand = readHeroHand(nimg, ranks);

  // fold 判定（isActiveHand）のルール決定（§B1 追補）。extractAnchored は固定座標プロファイル
  // （FrameProfile）を経由しないため機種が分からず、opts.handActive も誰も渡していなかった
  // （＝常に cardState 既定の Android 較正 bright/0.06 が使われ、iOS フレームでは active 席まで
  // fold と誤判定していた）。機種フラグを持たせる代わりに、**フレーム内の全席の blueFractions を
  // 先に集めて** pickHandActiveRule で自動判別する（cardState.ts 参照。Android は bright でしか
  // 切れず、iOS は bright が常に 0 で strong でしか切れないという実測に基づく）。
  // opts.handActive が明示されたら（extract.ts のプロファイル経路に対応）そちらを優先。
  // marks 経路ではカード裏を一切見ないので、全席の blueFractions を集めるプリパスも走らせない
  // （純粋に無駄な計算。ルール自体も使われないので既定値を置くだけ）。
  const handActiveRule: HandActiveRule =
    opts.handActive ??
    (marks
      ? { metric: 'bright', threshold: 0.06 }
      : pickHandActiveRule(
          occ.filter((s) => !s.isHero && s.nameBox).map((s) => blueFractions(nimg, cardRectFromName(s.nameBox!))),
        ));
  const handActiveOpts: CardStateOptions = { metric: handActiveRule.metric, activeFrac: handActiveRule.threshold };

  // 席（SLOTS 順）。
  const seats: RawSeatRead[] = seatsAdj.map((s) => {
    const isHero = s.isHero;
    if (!s.occupied) {
      return {
        id: s.slot,
        isHero,
        isButton: false,
        occupancy: { value: 'empty' as Occupancy, conf: 0.8 },
        action: { value: 'none' as SeatAction, conf: 0.8 },
        stack: { value: NaN, conf: 0 },
        bet: { value: 0, conf: 0.6 },
      };
    }

    // stack（名前直上 BB アンカー）。
    let stack: Read<number> = { value: NaN, conf: 0 };
    const sr = stackRectOf(s);
    if (sr && s.nameBox) {
      if (mode === 'bb') {
        stack = readStackAnchored(nimg, sr, s.nameBox.cx, digits, letters, scoreFloor);
        // 名前ボックス破綻席（hero 手番グロー / 折れ暗コーナー / iOS 小名）: 名前直上帯では数字帯を
        // 外し NaN になる。固定フラクショナル y のフォールバック帯で読み直す（§B4 の頑健化）。
        if (!Number.isFinite(stack.value)) {
          const fr = stackFallbackRect(nimg, s.slot, s.nameBox.cx, robustNameH);
          const fb = readStackAnchored(nimg, fr, s.nameBox.cx, digits, letters, scoreFloor);
          if (Number.isFinite(fb.value)) stack = fb;
        }
      } else {
        // chips: 名前直上帯を生読み → BB 正規化（chips は §B7 で棄却対象なので精度は不問）。
        stack = norm(recognizeAmount(nimg, sr, digits), bbChips);
      }
    }
    const stackParsed = Number.isFinite(stack.value);

    // occupancy（席は seatEnum が確定＝ここで落とさない, b2153df 継承）。
    const occupancy: Read<Occupancy> = {
      value: 'occupied',
      conf: stackParsed ? (stack.conf > 0 ? 0.9 : 0.5) : 0.4,
    };

    // action（本番 extract.ts のセマンティクスを踏襲・§B/§6.5）:
    //  - hero: 表向き。能動タグのみ読む（fold は BB ウォーク等で下流が別途扱う）。
    //  - 非 hero: cardState で fold 判定 → active なら能動タグを読む。
    // 能動タグ（raise/call/check/allin）は actions テンプレを渡したときだけ読む。読めば下流
    // spotReconstruction が raise / 非オールインの call（リンプ）/ walk を**対象外棄却**できる
    // （旧アンカー抽出はタグを読まず、BB 表示でも raise/limp 局面を受理していた＝過受理の一因）。
    // タグ帯は名前アンカーから actionZoneRect（本番 actionZone と同相対位置）。カード領域は
    // 名前直上のスタックの更に上（アバター帯）。
    let action: Read<SeatAction> = { value: 'none', conf: 0.6 };
    if (marks) {
      // マーク経路（既定・2026-09-10 以降）: 行動した席には必ず吹き出しプレートが出るので、
      // マークを読めば fold/call/raise/allin が確定し、**マークが無ければ未行動 = none** と
      // 言い切れる。カード裏の色（cardState）は使わない —— カード裏はユーザーが着せ替えられ、
      // 淡色スキンのフレームでは全席が「降りた」と誤判定された（実測 Screenshot_20260910-192316）。
      // hero も同じ経路で読む（対応スポットでは hero は手番＝マーク無し）。
      action = recognizeMark(nimg, markZoneRect(nimg, s.slot, s.nameBox, markGrid), marks);
    } else {
      // 従来経路（marks 未指定）: 回帰ゼロのため温存する。
      const az = actionZoneRect(nimg, s.slot, s.nameBox);
      if (isHero) {
        if (actions) action = recognizeAction(nimg, az, actions);
      } else if (s.nameBox) {
        const active = isActiveHand(nimg, cardRectFromName(s.nameBox), handActiveOpts);
        if (!active.value) action = { value: 'fold', conf: active.conf };
        else if (actions) action = recognizeAction(nimg, az, actions);
      }
      // allin: 能動タグが読めなかった（none）非 hero で stack がほぼ 0（シューブ済み）なら構造から
      // allin を確定（§B5 の精神・従来の allin 復旧を温存）。タグが raise/call/check を返した席は
      // 上書きしない（下流の対象外判定を尊重）。
      //
      // マーク経路ではこの推測を使わない: stack の誤読で偽の allin が出る（実測 142903/142909 の
      // TC）。マークが無ければ未行動と確定できるので、推測で埋める必要がそもそも無い。読み落と
      // した本物の allin は bet が全額で残るため、下流が「未分類のベット」として利用者に出す。
      if (!isHero && action.value === 'none' && stackParsed && stack.value < 0.5) {
        action = { value: 'allin', conf: 0.6 };
      }
    }

    // ベット読み（fix 1/2）: 席前チップ "N BB" を BB アンカーで読む。ブラインド投函（SB=0.5/BB=1）や
    // allin の全額（例 5.9 BB）を捕捉し、下流 root 逆算に putIn として渡す（bet=0 だと SB/BB が
    // −0.5/−1.0 ずれ、allin は root 潰れ）。チップ無し席は NaN → bet=0（幻レイズ棄却を避ける, §B8）。
    // 折れ済み席は投函チップが場に無い前提（未オープン局面）なので読まない＝bet 0（＝下流で dead blind
    // のみ putIn）。hero も SB/BB になりうるので読む。
    let betRead: Read<number> = { value: NaN, conf: 0 };
    if (s.nameBox && action.value !== 'fold') {
      betRead = readBetAnchored(nimg, s.slot, s.nameBox, digits, letters, scoreFloor);
    }
    let betVal = Number.isFinite(betRead.value) ? betRead.value : 0;
    let betConf = Number.isFinite(betRead.value) ? betRead.conf : 0.4;
    // allin 席で bet が読めない稀ケース: stack≈0 のまま bet=0 だと rootStack<0 で zod 棄却。
    // bb 下駄（blindOb 上限）で rootStack≥0 を保証（従来の割り切りを allin 復旧フォールバックとして温存）。
    if (action.value === 'allin' && !(betVal > 0) && Number.isFinite(bbNorm)) {
      betVal = bbNorm;
      betConf = 0.3;
    }

    return {
      id: s.slot,
      isHero,
      isButton: buttonSlot === s.slot,
      occupancy,
      action,
      stack,
      bet: { value: betVal, conf: betConf },
    };
  });

  // ブラインド（BB 換算）。ブラインドが解決できたら **正規化ブラインドは厳密値**（クラブマッチは
  // SB=BB/2 で確定・BB 換算では常に sb=0.5 / bb=1.0）に上書きし、ヘッダ数値の誤読（実測 2.44 で sb≒0.60）を
  // 根治する（さつき: SB/BB は決まっている）。rb.sb/rb.bb は常に 0.5。解決不可（BB 読めず）は従来の
  // sanitizeBlinds（回帰ゼロ）。conf 0.9 で確認画面の低信頼強調からも外す。
  const blinds = rb
    ? { sb: { value: rb.sb / rb.bb, conf: 0.9 }, bb: { value: 1, conf: 0.9 } }
    : sanitizeBlinds(norm(blindsRaw.sb, bbChips), norm(blindsRaw.bb, bbChips));

  return {
    street: { value: 'preflop', conf: 0.8 }, // アンカー抽出はプリフロップ終了フレーム前提（§A）。
    blinds,
    ante: { scheme: opts.anteScheme ?? 'all', amount: norm(anteChips, bbChips) },
    pot,
    heroHand,
    seats,
    displayMode: mode,
    ...(rb ? { blindChips: { sb: rb.sb, bb: rb.bb, ante: rb.ante, level: rb.level } } : {}),
  };
}
