/**
 * 画面レイアウト幾何（領域抽出の座標モデル）。SPEC §6.2/§6.4。
 *
 * 各読み取り対象（ストリート表示・ブラインド・ポット・hero 手札・各席のスタック/
 * ベット/ボタン/プレゼンス）を、フレームサイズに対する**割合矩形**で定義する。
 * 割合にするのは機種差の解像度・アスペクトを吸収するため（§6.3 の真のリスク）。
 *
 * 実際の座標プロファイルは利用者スクショから較正する（後続）。ここでは
 *   - 割合矩形 → ピクセル矩形 の変換
 *   - プロファイル → 解決済み領域一式
 *   - 物理席リング順（時計回り）の妥当性
 * という**画像非依存の器**を確定・検証する。座標値そのものは calibration で埋める。
 */

import type { Rect } from './types.js';

/** フレームに対する割合矩形（各成分 [0,1]）。 */
export interface FracRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** 1 つの物理席の領域群。 */
export interface SeatRegions {
  /** スタック数字。 */
  readonly stack: FracRect;
  /** 席前のベット額。 */
  readonly bet: FracRect;
  /** D ボタンが載りうる位置（テンプレマッチ範囲）。 */
  readonly button: FracRect;
  /** 手札の有無（生存/フォールド/不在の視覚判定）を見る領域。 */
  readonly presence: FracRect;
}

/**
 * レイアウトプロファイル。physicalSeats は画面上の席を**時計回り**に並べる
 * （＝プリフロップの進行方向。derivePositions のリング順と一致）。
 */
export interface LayoutProfile {
  readonly name: string;
  /** フレームのアスペクト比（w/h）。較正時の適合判定に使う。 */
  readonly aspect: number;
  readonly streetLabel: FracRect;
  readonly blindsLabel: FracRect;
  readonly pot: FracRect;
  readonly heroCard1: FracRect;
  readonly heroCard2: FracRect;
  /** 時計回りの物理席（最大 6）。 */
  readonly physicalSeats: readonly SeatRegions[];
}

/** 割合矩形 → ピクセル矩形。フレーム内にクランプ。 */
export function toPx(frac: FracRect, frameW: number, frameH: number): Rect {
  const x = Math.round(frac.x * frameW);
  const y = Math.round(frac.y * frameH);
  const w = Math.round(frac.w * frameW);
  const h = Math.round(frac.h * frameH);
  const cx = Math.max(0, Math.min(frameW, x));
  const cy = Math.max(0, Math.min(frameH, y));
  return { x: cx, y: cy, w: Math.max(0, Math.min(frameW - cx, w)), h: Math.max(0, Math.min(frameH - cy, h)) };
}

export interface ResolvedSeatRegions {
  readonly stack: Rect;
  readonly bet: Rect;
  readonly button: Rect;
  readonly presence: Rect;
}

export interface ResolvedRegions {
  readonly streetLabel: Rect;
  readonly blindsLabel: Rect;
  readonly pot: Rect;
  readonly heroCard1: Rect;
  readonly heroCard2: Rect;
  readonly seats: readonly ResolvedSeatRegions[];
}

/** プロファイル＋フレームサイズ → 解決済み px 領域一式。 */
export function resolveRegions(
  profile: LayoutProfile,
  frameW: number,
  frameH: number,
): ResolvedRegions {
  const px = (f: FracRect) => toPx(f, frameW, frameH);
  return {
    streetLabel: px(profile.streetLabel),
    blindsLabel: px(profile.blindsLabel),
    pot: px(profile.pot),
    heroCard1: px(profile.heroCard1),
    heroCard2: px(profile.heroCard2),
    seats: profile.physicalSeats.map((s) => ({
      stack: px(s.stack),
      bet: px(s.bet),
      button: px(s.button),
      presence: px(s.presence),
    })),
  };
}

/** プロファイルの割合矩形が全て [0,1] 内かを検証（較正データの健全性チェック）。 */
export function validateProfile(profile: LayoutProfile): string[] {
  const issues: string[] = [];
  const check = (f: FracRect, name: string) => {
    if (f.x < 0 || f.y < 0 || f.x + f.w > 1 + 1e-9 || f.y + f.h > 1 + 1e-9) {
      issues.push(`${name} がフレーム外です`);
    }
    if (f.w <= 0 || f.h <= 0) issues.push(`${name} のサイズが不正です`);
  };
  check(profile.streetLabel, 'streetLabel');
  check(profile.blindsLabel, 'blindsLabel');
  check(profile.pot, 'pot');
  check(profile.heroCard1, 'heroCard1');
  check(profile.heroCard2, 'heroCard2');
  if (profile.physicalSeats.length < 2 || profile.physicalSeats.length > 6) {
    issues.push('physicalSeats は 2..6');
  }
  profile.physicalSeats.forEach((s, i) => {
    check(s.stack, `seat${i}.stack`);
    check(s.bet, `seat${i}.bet`);
    check(s.button, `seat${i}.button`);
    check(s.presence, `seat${i}.presence`);
  });
  return issues;
}
