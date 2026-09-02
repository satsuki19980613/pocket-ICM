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
import { readBlinds } from './blinds.js';
import { readStreetFromBoard } from './street.js';
import { detectButtonSeat } from './button.js';
import { isActiveHand } from './cardState.js';
import { recognizeAction } from './actionTag.js';
import { findCardRects } from './detect.js';
import { grayFromRgba } from './numberField.js';
import { recognizeHeroHandColor } from './cards.js';

export interface ExtractTemplates {
  /** 数字 0-9 ＋ '/'（blinds 分割用）。 */
  readonly digits: readonly Template[];
  /** カードランク（"2".."9","10","J","Q","K","A"）。 */
  readonly ranks: readonly Template[];
  /** 能動アクション語（レイズ/コール/オールイン/チェック）。 */
  readonly actions: readonly Template[];
}

export interface ExtractOptions {
  /** 数値表示モード（既定 chips）。'bb'（小数）は未対応。 */
  readonly displayMode?: DisplayMode;
  /** アンティ方式（既定 'all'）。 */
  readonly anteScheme?: AnteScheme;
  /** ベット読みの minCh（既定は numberField 既定）。 */
  readonly betMinCh?: number;
}

const px = (img: Rgba, f: FracRect): Rect => toPx(f, img.w, img.h);
const norm = (r: Read<number>, bb: number): Read<number> =>
  bb > 0 && Number.isFinite(r.value) ? { value: r.value / bb, conf: r.conf } : { value: r.value, conf: r.conf };

/**
 * フレーム → RawReads（chips 表示前提, 金額は BB 換算）。
 * 席は profile.seats の時計回り順で並ぶ（derivePositions のリング順）。
 */
export function extractRawReads(
  img: Rgba,
  profile: FrameProfile,
  templates: ExtractTemplates,
  opts: ExtractOptions = {},
): RawReads {
  const street = readStreetFromBoard(img, px(img, profile.board));
  const blinds = readBlinds(img, px(img, profile.blindsNum), templates.digits);
  const bbChips = Number.isFinite(blinds.bb.value) && blinds.bb.value > 0 ? blinds.bb.value : 1;

  // 金額は bb(chips) で割って BB 換算。
  const anteChips = recognizeAmount(img, px(img, profile.ante), templates.digits);
  const pot = norm(recognizeAmount(img, px(img, profile.pot), templates.digits), bbChips);

  // D ボタン席（席アンカーは profile.seats の順）。
  const anchors = profile.seats.map((s) => s.buttonAnchor);
  const button = detectButtonSeat(img, px(img, profile.table), anchors);

  // hero 手札（帯の 2 枚を検出）。
  const heroSeat = profile.seats.find((s) => s.isHero);
  let heroHand: Read<string> = { value: '', conf: 0 };
  if (heroSeat) {
    const hrect = px(img, heroSeat.card);
    const g = grayFromRgba(img, hrect);
    const rects = findCardRects(g, { threshold: 190, minAreaFrac: 0.02, closeRadius: 1 })
      .map((r) => ({ x: hrect.x + r.x, y: hrect.y + r.y, w: r.w, h: r.h }));
    if (rects.length >= 2) heroHand = recognizeHeroHandColor(img, rects[0]!, rects[1]!, templates.ranks);
  }

  const seats: RawSeatRead[] = profile.seats.map((s, i) => {
    const stackRaw = recognizeAmount(img, px(img, s.stack), templates.digits, s.stackMinCh !== undefined ? { minCh: s.stackMinCh } : {});
    const occupied = Number.isFinite(stackRaw.value);
    const occupancy: Read<Occupancy> = occupied
      ? { value: 'occupied', conf: stackRaw.conf > 0 ? 0.9 : 0.5 }
      : { value: 'empty', conf: 0.8 };

    const betRaw = recognizeAmount(img, px(img, s.bet), templates.digits, opts.betMinCh !== undefined ? { minCh: opts.betMinCh } : {});
    const bet: Read<number> = Number.isFinite(betRaw.value)
      ? norm(betRaw, bbChips)
      : { value: 0, conf: 0.6 };

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
      stack: norm(stackRaw, bbChips),
      bet,
    };
  });

  return {
    street,
    blinds: { sb: norm(blinds.sb, bbChips), bb: norm(blinds.bb, bbChips) },
    ante: { scheme: opts.anteScheme ?? 'all', amount: norm(anteChips, bbChips) },
    pot,
    heroHand,
    seats,
    displayMode: opts.displayMode ?? 'chips',
  };
}
