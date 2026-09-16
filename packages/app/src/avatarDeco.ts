/**
 * アバターの「枠の色」＋「バッジ」を1箇所にまとめる純モジュール。
 * デザインは 2026-09-16 さつき承認のデザイン案（枠はアイコン内側に ::after で描く・
 * バッジは左下の黒丸＋SVG）を踏襲している。
 * 使う場所（feedShared.tsx の Avatar・RankingModal.tsx・Settings.tsx・GlassTable.tsx の
 * 席アイコン）はどれもここの `resolveAvatarDeco` の戻り値をそのままクラス名/style に
 * 展開するだけにして、色の意味づけ（steel が既定・special は管理者付与のみ等）を
 * このファイル以外に散らばらせない。
 *
 * DB 列（public.profiles、supabase/migrations/0012 で追加）:
 *   frame_color   text NOT NULL DEFAULT 'steel'  ∈ steel|yellow|cyan|red|white|purple|special（本人が選べる）
 *   special_frame text NULL — 'prism' か '#rrggbb'（小文字）。管理者のみ付与
 *   badge         text NULL — 'crab'（管理者のみ付与。本人が外す設定は無い＝付与されたら常に出す）
 *
 * 値は他人の投稿・卓の相手も含め「サーバから来た文字列」なので、想定外の値が来ても
 * 表示が壊れないよう防御的に解決する（未知の frame_color・special なのに special_frame が
 * 無い/不正な16進・未知の badge は、どれも安全側＝steel/バッジ無しへ丸める）。
 */
import React from 'react';
import CRAB_BADGE_URL from './assets/badge-crab.svg';

/** 本人が選べる通常色（6色）。styles.css の `.ring-*` と対応する。 */
export const NORMAL_FRAME_COLORS = ['steel', 'yellow', 'cyan', 'red', 'white', 'purple'] as const;
export type NormalFrameColor = (typeof NORMAL_FRAME_COLORS)[number];

/** 特別枠込みの frame_color の全体（DB constraint と同じ列挙）。 */
export type FrameColor = NormalFrameColor | 'special';

/** 管理者が付与できるバッジ（今は蟹の1種類のみ）。 */
export type BadgeId = 'crab';

/** resolveAvatarDeco への入力。DB 行の該当3列をそのまま渡せる形にしてある。 */
export interface AvatarDecoInput {
  readonly frame_color?: string | null;
  readonly special_frame?: string | null;
  readonly badge?: string | null;
}

/**
 * 表示に必要なぶんへ解決した結果。`ringClass` は `.av`/`.avbig`/`.sgt-av` へ足すクラス名
 * （例 "ring-steel" / "ring-special ring-prism"）、`ringStyle` は特別枠（hex 指定）のときだけ
 * 値を持つ CSS カスタムプロパティ（--sp 系）。通常色・prism は静的な CSS だけで描けるので
 * ringStyle は undefined のままでよい。
 */
export interface AvatarDeco {
  readonly ringClass: string;
  readonly ringStyle: Readonly<Record<string, string>> | undefined;
  readonly badge: BadgeId | null;
}

const HEX_RE = /^#[0-9a-f]{6}$/;

/** 管理者が付与する special_frame の16進表記か（小文字固定・#rrggbb）。 */
export function isValidHex(v: string): boolean {
  return HEX_RE.test(v);
}

function isNormalFrameColor(v: unknown): v is NormalFrameColor {
  return typeof v === 'string' && (NORMAL_FRAME_COLORS as readonly string[]).includes(v);
}

/**
 * 管理者が付与した16進色から、特別枠の濃淡・光彩を作る（2026-09-16 承認案の計算式を、
 * ネオンで浮く見え方を指摘されて retune: 明色は白へ35%寄せ、暗色は60%に落とし、
 * 光彩はその色の rgba(...,0.28)。式の形自体は元のまま、係数だけ抑えている）。
 */
export function specialVars(hex: string): Record<string, string> {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const mix = (t: number, k: number): number => Math.round(k + (t - k) * 0.35);
  const hi = `rgb(${mix(255, r)},${mix(255, g)},${mix(255, b)})`;
  const lo = `rgb(${Math.round(r * 0.6)},${Math.round(g * 0.6)},${Math.round(b * 0.6)})`;
  return {
    '--sp': hex,
    '--sp-hi': hi,
    '--sp-lo': lo,
    '--sp-glow': `rgba(${r},${g},${b},0.28)`,
  };
}

const STEEL: AvatarDeco = { ringClass: 'ring-steel', ringStyle: undefined, badge: null };

/**
 * DB の3列 → 表示用の枠・バッジ。防御的な丸め方針:
 * - frame_color が未知/欠損 → steel
 * - frame_color === 'special' なのに special_frame が無い/不正 → steel（管理者付与前の事故防止）
 * - special_frame === 'prism' → 回転する虹色（ring-special ring-prism）
 * - special_frame が有効な #rrggbb → その色から算出した金属調グラデーション
 * - badge が 'crab' 以外（未知/欠損）→ null（バッジ無し）
 */
export function resolveAvatarDeco(input: AvatarDecoInput | null | undefined): AvatarDeco {
  const badge: BadgeId | null = input?.badge === 'crab' ? 'crab' : null;
  const frameColor = input?.frame_color;

  if (frameColor === 'special') {
    const sp = input?.special_frame;
    if (sp === 'prism') {
      return { ringClass: 'ring-special ring-prism', ringStyle: undefined, badge };
    }
    if (typeof sp === 'string' && isValidHex(sp)) {
      return { ringClass: 'ring-special', ringStyle: specialVars(sp), badge };
    }
    return { ...STEEL, badge };
  }

  if (isNormalFrameColor(frameColor)) {
    return { ringClass: `ring-${frameColor}`, ringStyle: undefined, badge };
  }
  return { ...STEEL, badge };
}

/**
 * バッジの描画（左下の黒丸＋蟹の SVG）。全箇所（feedShared.tsx の Avatar・GlassTable.tsx の
 * 席アイコン・RankingModal.tsx・Settings.tsx）で使う共通部品なので、レンダリング先ごとに
 * DOM 構造が食い違わないようここへ1つだけ置く。クリックを奪わないよう pointer-events は
 * CSS 側（`.av-badge`）で殺す。JSX 構文を使わず `React.createElement` にしているのは、この
 * ファイルを拡張子 `.ts` のまま（＝純関数モジュールとそのテストに JSX を持ち込まずに）
 * 書けるようにするため。
 */
export function AvatarBadge(): JSX.Element {
  return React.createElement(
    'span',
    { className: 'av-badge', role: 'img', 'aria-label': 'カニのバッジ' },
    React.createElement('img', { src: CRAB_BADGE_URL, alt: '', draggable: false }),
  );
}
