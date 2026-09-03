/**
 * フレーム抽出（rgba → RawReads）。SPEC §6.2-6.4。抽出層の中核。
 *
 * FrameProfile の各領域を、確定済みの検出器で読み取って RawReads を組み立てる:
 *  - street: 中央ボードのカード枚数（street.ts）
 *  - blinds: "330/660" を SB/BB 分割（blinds.ts）→ chips の bb がスタックの正規化係数
 *  - ante/pot/stack/bet: 白マスク→連結成分→NCC（numberField.ts）
 *  - D ボタン席: 最大ゴールドディスク→席アンカー（button.ts）
 *  - occupancy: スタックが読めるか（empty はプレート自体が無い）
 *  - action: fold はカード裏状態（cardState.ts）、能動タグはプレート文字（actionTag.ts）
 *  - heroHand: hero 帯の 2 枚を検出→ランク NCC＋スート色（cards.ts）
 *
 * 金額は RawReads の契約どおり **BB 換算**。chips 表示では全額を bb(chips) で割る。
 * BB 表示（小数）モードは別パス（未対応: displayMode='bb' は要小数対応）で、ここでは
 * chips 表示を対象とする。
 */

import type { AnteScheme, DisplayMode, Occupancy, RawReads, RawSeatRead, Read, Rect, SeatAction } from './types.js';
import type { Rgba } from './color.js';
import type { Template } from './match.js';
import type { FracRect } from './layout.js';
import { toPx } from './layout.js';
import type { FrameProfile } from './frameProfile.js';
import { recognizeAmount } from './numberField.js';
import { readAmountBb, detectDisplayMode } from './bbAmount.js';
import { readBlinds } from './blinds.js';
import { readStreetFromBoard } from './street.js';
import { detectButtonSeat } from './button.js';
import { isActiveHand } from './cardState.js';
import { recognizeAction } from './actionTag.js';
import { findCardRects, largestCardRects } from './detect.js';
import { grayFromRgba } from './numberField.js';
import { recognizeHeroHandColor } from './cards.js';
import { mapProfile, detectContentRect, isFullFrame, type ContentRect } from './contentRect.js';
import { normalizeToCanonical } from './resize.js';

export interface ExtractTemplates {
  /** 数字 0-9 ＋ '/'（blinds 分割用）。 */
  readonly digits: readonly Template[];
  /** カードランク（"2".."9","10","J","Q","K","A"）。 */
  readonly ranks: readonly Template[];
  /** 能動アクション語（レイズ/コール/オールイン/チェック）。 */
  readonly actions: readonly Template[];
  /** BB 表示判定用の "B" 文字（label 'B'）。省略時はモード自動判定せず chips 既定。 */
  readonly letters?: readonly Template[];
}

export interface ExtractOptions {
  /** 数値表示モード。未指定なら letters があれば自動判定、無ければ chips。 */
  readonly displayMode?: DisplayMode;
  /** アンティ方式（既定 'all'）。 */
  readonly anteScheme?: AnteScheme;
  /** ベット読みの minCh（既定は numberField 既定, chips 表示のみ）。 */
  readonly betMinCh?: number;
  /**
   * コンテンツ矩形（プレイエリア）。機種差（iOS セーフエリア等）でゲーム描画が画面内の
   * 部分矩形に収まる場合、profile 座標をこの矩形へ写像する。未指定なら全画面（Android 較正のまま）。
   */
  readonly contentRect?: ContentRect;
}

const px = (img: Rgba, f: FracRect): Rect => toPx(f, img.w, img.h);
const norm = (r: Read<number>, bb: number): Read<number> =>
  bb > 0 && Number.isFinite(r.value) ? { value: r.value / bb, conf: r.conf } : { value: r.value, conf: r.conf };

/**
 * ブラインドのサニタイズ。SB < BB はポーカーの不変条件。低解像度でヘッダ "600/1200" の
 * SB を誤読して sb>=bb になると、下流の buildBoardState が「SB は BB より小さく」で
 * ハード拒否し、プリフィル→確認の流れが死ぬ（実 iPhone で観測）。sb が不正（非有限/
 * <=0/>=bb）なら **bb の半分**（この game の標準・SB=BB/2）に置換し、低信頼でフラグする
 * （確認画面で強調され、利用者が修正できる＝プリフィルの原則を維持）。bb が読めない時は触らない。
 */
function sanitizeBlinds(sb: Read<number>, bb: Read<number>): { sb: Read<number>; bb: Read<number> } {
  if (Number.isFinite(bb.value) && bb.value > 0) {
    const bad = !Number.isFinite(sb.value) || sb.value <= 0 || sb.value >= bb.value;
    if (bad) return { sb: { value: bb.value / 2, conf: Math.min(sb.conf, 0.3) }, bb };
  }
  return { sb, bb };
}

/**
 * フレーム → RawReads（chips 表示前提, 金額は BB 換算）。
 * 席は profile.seats の時計回り順で並ぶ（derivePositions のリング順）。
 */
export function extractRawReads(
  img: Rgba,
  profileIn: FrameProfile,
  templates: ExtractTemplates,
  opts: ExtractOptions = {},
): RawReads {
  // コンテンツ矩形が指定されていれば profile をその矩形へ写像（機種差の吸収）。
  const profile = opts.contentRect ? mapProfile(profileIn, opts.contentRect) : profileIn;
  const street = readStreetFromBoard(img, px(img, profile.board));
  // blinds / ante は BB 表示でもヘッダは常に chips。bb(chips)=正規化係数。
  const blinds = readBlinds(img, px(img, profile.blindsNum), templates.digits);
  const bbChips = Number.isFinite(blinds.bb.value) && blinds.bb.value > 0 ? blinds.bb.value : 1;

  // 表示モード解決: 明示指定 > letters による自動判定 > chips。
  // hero スタックが最もクリーン（実画像 hero 101/101 で分離）なので **hero を先頭**に並べて
  // 主判定に使う。HU(2人)では profile 順の先頭が相手席（TC の装飾ネームプレートで "BB" 接尾辞
  // 検出が崩れる）になり bb→chips 誤判定していた（124600 が有効局面を false-reject する原因）。
  // hero が読めない場合のみ残り席へフォールバック（stable sort で順序保持）。
  const modeSeats = [...profile.seats].sort((a, b) => (b.isHero ? 1 : 0) - (a.isHero ? 1 : 0));
  const mode: DisplayMode =
    opts.displayMode ??
    (templates.letters
      ? detectDisplayMode(img, modeSeats.map((s) => px(img, s.stack)), templates.digits, templates.letters)
      : 'chips');

  // テーブル上の金額（stack/bet/pot）を BB 換算で読む。
  //  - chips: recognizeAmount → bb(chips) で割る。
  //  - bb: readAmountBb（"20.2 BB"→20.2, 既に BB）→ 正規化しない。
  const readTable = (rect: Rect, minCh?: number): Read<number> =>
    mode === 'bb'
      ? readAmountBb(img, rect, templates.digits, minCh !== undefined ? { minCh } : {})
      : norm(recognizeAmount(img, rect, templates.digits, minCh !== undefined ? { minCh } : {}), bbChips);

  // ante は常に chips ヘッダ → recognizeAmount＋正規化。
  const anteChips = recognizeAmount(img, px(img, profile.ante), templates.digits);
  const pot = readTable(px(img, profile.pot));

  // D ボタン席（席アンカーは profile.seats の順）。
  const anchors = profile.seats.map((s) => s.buttonAnchor);
  const button = detectButtonSeat(img, px(img, profile.table), anchors);

  // hero 手札（帯の 2 枚を検出）。
  const heroSeat = profile.seats.find((s) => s.isHero);
  let heroHand: Read<string> = { value: '', conf: 0 };
  if (heroSeat) {
    const hrect = px(img, heroSeat.card);
    const g = grayFromRgba(img, hrect);
    const found = findCardRects(g, { threshold: 190, minAreaFrac: 0.02, closeRadius: 1 })
      .map((r) => ({ x: hrect.x + r.x, y: hrect.y + r.y, w: r.w, h: r.h }));
    // 絵札の内部スプリアス矩形を避け、面積上位 2 枚を左→右で採る。
    const rects = largestCardRects(found, 2);
    if (rects.length >= 2) heroHand = recognizeHeroHandColor(img, rects[0]!, rects[1]!, templates.ranks);
  }

  const seats: RawSeatRead[] = profile.seats.map((s, i) => {
    // stackMinCh（ホログラム加工プレートのキラキラ除去）は BB でも有効（BL 実測 168 で
    // 13.5/7.8 等を正読・小数点も生存）。両モードで適用する。
    const stack = readTable(px(img, s.stack), s.stackMinCh);
    const occupied = Number.isFinite(stack.value);
    const occupancy: Read<Occupancy> = occupied
      ? { value: 'occupied', conf: stack.conf > 0 ? 0.9 : 0.5 }
      : { value: 'empty', conf: 0.8 };

    // BB 表示は先頭 "0." が左端で切れる席（BC/BL/TC/TR）向けに betBb（左に余白）を使う。
    const betRect = px(img, mode === 'bb' ? s.betBb ?? s.bet : s.bet);
    const betRaw = readTable(betRect, mode === 'chips' ? opts.betMinCh : undefined);
    const bet: Read<number> = Number.isFinite(betRaw.value) ? betRaw : { value: 0, conf: 0.6 };

    let action: Read<SeatAction>;
    if (!occupied) {
      action = { value: 'none', conf: 0.8 };
    } else if (s.isHero) {
      // hero は表向き。能動タグのみ見る（fold は BB ウォーク等で別途扱い）。
      action = recognizeAction(img, px(img, s.actionZone), templates.actions);
    } else {
      const active = isActiveHand(img, px(img, s.card));
      if (!active.value) {
        action = { value: 'fold', conf: active.conf };
      } else {
        action = recognizeAction(img, px(img, s.actionZone), templates.actions);
      }
    }

    return {
      id: s.screen,
      isHero: s.isHero,
      isButton: button.value === i,
      occupancy,
      action,
      stack,
      bet,
    };
  });

  return {
    street,
    blinds: sanitizeBlinds(norm(blinds.sb, bbChips), norm(blinds.bb, bbChips)),
    ante: { scheme: opts.anteScheme ?? 'all', amount: norm(anteChips, bbChips) },
    pot,
    heroHand,
    seats,
    displayMode: mode,
  };
}

/**
 * コンテンツ矩形を自動検出してから抽出する（多機種対応の入口）。
 * Android 2730×1260 は全画面と判定され従来と同一。iOS セーフエリア等で内寄せされた
 * 機種は検出した矩形へ写像して読む。検出された矩形も返す（デバッグ/確認用）。
 */
/**
 * コンテンツ矩形を自動検出し、較正解像度(2730×1260)へ拡大してから抽出する（多機種対応の入口）。
 * Android 2730×1260 は全画面と判定され従来と同一（正規化=恒等）。低解像度スマホは検出した矩形へ
 * 切り出し拡大して読む。※低解像度の細かな数値（小数点・BB/chips 判別）の精度は解像度依存の
 * 認識器較正（テンプレ再作成）が別途必要。検出した矩形も返す（デバッグ/確認用）。
 */
export function extractRawReadsAuto(
  img: Rgba,
  profile: FrameProfile,
  templates: ExtractTemplates,
  opts: ExtractOptions = {},
): { reads: RawReads; contentRect: ContentRect } {
  const canonW = 2730;
  const canonH = Math.round(canonW / profile.aspect);
  const contentRect = opts.contentRect ?? detectContentRect(img, profile, templates.digits);
  const normalized = normalizeToCanonical(img, contentRect, canonW, canonH);
  const reads = extractRawReads(normalized, profile, templates, { ...opts, contentRect: undefined });
  return { reads, contentRect };
}
