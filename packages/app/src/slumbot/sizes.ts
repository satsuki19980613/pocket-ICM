/**
 * ベットサイズのプリセット（ハンドの下に並ぶ [2bb][2.3bb]… のボタン）。
 *
 * 「どの場面でどの単位を使うか」は 4 カテゴリに分かれる:
 *   pfOpen     プリフロップでまだ誰もレイズしていない  → bb 指定
 *   pfVsRaise  プリフロップでレイズを受けている        → 相手のレイズ額の倍率（x）か bb
 *   postBet    ポストフロップで誰もベットしていない    → ポット比（%）
 *   postVsBet  ポストフロップでベットを受けている      → 倍率（x）かポット比（%）
 *
 * どのカテゴリにも「Max（オールイン）」が必ず末尾に付き、これは削除できない。
 * 利用者が足せるのは各カテゴリ 15 個まで（画面右下の「n/15」がこれ）。
 *
 * 単位は一貫してチップ。プリセットの解決結果は「そのストリートでの累計ベット額」で返す
 * （Slumbot（HU）なら b<N> の N、SIT & GO なら act の betTo）。
 *
 * ---- 一般化（docs/SNG_DESIGN.md §6・A3a）----
 * 当初 Slumbot HU 専用の `HandState`（2 席固定・両者常に同スタック 20000）だけを受けていたが、
 * SIT & GO（2〜6 席・スタック不同）でも同じプリセット計算を使うため、**必要な数値だけの
 * 最小インターフェース `SizingState`** を切り出した。中身は全部 `*Sizing` 関数に集約し、
 * HU 向けの公開関数（`categoryOf` 等）は `HandState → SizingState` の薄い変換
 * （`fromHandState`）を挟むだけの後方互換ラッパーにした。
 *
 * `fromHandState` が `actingRemaining`/`actingStreetBet` に落とし込む値は、HU の
 * `legalActions()`（rules.ts）が使う `STACK − totalLastBetTo` 方式と数値的に完全に一致する
 * （HU は毎ハンド両者同スタックのため、街の区切りで常に carry が両者同額になり、どちらの式で
 * 計算しても同じ「そのハンドで到達しうる最大到達額」になる）。既存の呼び出し・
 * `sizes.test.ts` は一切変更していない（数値まで往復確認済み）。
 *
 * SIT & GO 側は `packages/app/src/sng/betting.ts` の `toSizingState(hand, seat, stack)`
 * （`PublicHand` + 席 + 残りスタック → `SizingState`）経由でこのファイルの `*Sizing` 関数を呼ぶ。
 */

import { BB, potOf, stackOf, type HandState } from './rules';

/** プリセット 1 個。`max` は値を持たない特別枠。 */
export type SizeUnit = 'bb' | 'x' | 'pct';
export interface SizePreset {
  readonly unit: SizeUnit;
  readonly value: number;
}

export type SizeCategory = 'pfOpen' | 'pfVsRaise' | 'postBet' | 'postVsBet';

export const CATEGORY_LABEL: Record<SizeCategory, string> = {
  pfOpen: 'Preflop: オープンレイズ',
  pfVsRaise: 'Preflop: vs レイズ',
  postBet: 'Postflop: ベット',
  postVsBet: 'Postflop: vs ベット/レイズ',
};

/** カテゴリごとに使える単位（先頭が「追加」欄の既定）。 */
export const CATEGORY_UNITS: Record<SizeCategory, readonly SizeUnit[]> = {
  pfOpen: ['bb'],
  pfVsRaise: ['bb', 'x'],
  postBet: ['pct'],
  postVsBet: ['x', 'pct'],
};

/** 1 カテゴリに登録できる上限（Max は含めない）。 */
export const MAX_PRESETS = 15;

/** スライダーの刻み（bb）。画像の「ベットサイズハンドル 調整単位」。 */
export const HANDLE_UNITS = [0.1, 0.2, 0.5, 1, 2, 5] as const;
export type HandleUnit = (typeof HANDLE_UNITS)[number];

export interface BetSizeConfig {
  readonly handleUnit: HandleUnit;
  readonly pfOpen: readonly SizePreset[];
  readonly pfVsRaise: readonly SizePreset[];
  readonly postBet: readonly SizePreset[];
  readonly postVsBet: readonly SizePreset[];
}

const bb = (value: number): SizePreset => ({ unit: 'bb', value });
const x = (value: number): SizePreset => ({ unit: 'x', value });
const pct = (value: number): SizePreset => ({ unit: 'pct', value });

export const DEFAULT_BET_SIZES: BetSizeConfig = {
  handleUnit: 1,
  pfOpen: [bb(2), bb(2.3), bb(2.5), bb(3), bb(4), bb(5)],
  pfVsRaise: [x(2), x(2.5), x(3), x(3.5), x(4), x(4.5), x(5)],
  postBet: [
    pct(10), pct(25), pct(33), pct(50), pct(75), pct(100),
    pct(125), pct(150), pct(175), pct(200), pct(250), pct(300),
  ],
  postVsBet: [x(2), x(2.5), x(3), x(4), x(5), pct(33), pct(50), pct(75), pct(100)],
};

/** プリセットの安定キー（React の key と「いま選んでいるもの」の識別に使う）。 */
export function presetKey(p: SizePreset): string {
  return `${p.unit}-${p.value}`;
}

/** ボタンに出す短いラベル（値と単位を分けて返す。UI で単位だけ小さく出すため）。 */
export function presetLabel(p: SizePreset): { value: string; unit: string } {
  const v = String(Number(p.value.toFixed(2)));
  switch (p.unit) {
    case 'bb':
      return { value: v, unit: 'bb' };
    case 'x':
      return { value: v, unit: 'x' };
    case 'pct':
      return { value: v, unit: '%' };
  }
}

// ---------------------------------------------------------------------------
// 一般化（SizingState）: HU/SNG 共通のプリセット計算コア
// ---------------------------------------------------------------------------

/**
 * プリセット計算に必要な数値だけの最小インターフェース。
 * HU（`HandState`）・SNG（`PublicHand`）のどちらからも `*Sizing でない方の薄い変換関数で作る。
 */
export interface SizingState {
  /** 0=preflop … 3=river。 */
  readonly street: number;
  /** 現在の BB（チップ）。SNG はレベルで変わる・HU は常に 100。 */
  readonly bb: number;
  /** このストリートのトップベット額（「そこまで」）。誰も張っていなければ 0。 */
  readonly streetLastBetTo: number;
  /** 直前のベット/レイズの上乗せ幅（最小レイズの基準）。 */
  readonly lastBetSize: number;
  /** 手番の席が、このストリートで既に出した額。 */
  readonly actingStreetBet: number;
  /** 手番の席の残りスタック（このストリートで既に出した額は含まない＝追加で出せる上限）。 */
  readonly actingRemaining: number;
  /** 現在の総ポット（このストリートの分を含む・全員ぶん）。 */
  readonly pot: number;
}

interface SizingLegal {
  readonly canBet: boolean;
  readonly minBetTo: number;
  readonly maxBetTo: number;
}

/** 手番の席が用意しなければならないコール額。 */
function callOfSizing(s: SizingState): number {
  return Math.max(0, s.streetLastBetTo - s.actingStreetBet);
}

/**
 * ベット/レイズの合法域。`actingStreetBet + actingRemaining` が「このハンドでこの席が
 * 到達しうる最大到達額」（オールインしたときの累計）になる。
 */
function legalOfSizing(s: SizingState): SizingLegal {
  const totalReachable = s.actingStreetBet + s.actingRemaining;
  const remaining = totalReachable - s.streetLastBetTo;
  let minInc = s.lastBetSize > 0 ? Math.max(s.lastBetSize, s.bb) : s.bb;
  if (minInc > remaining) minInc = remaining; // オールインは常に合法。
  return {
    canBet: remaining > 0,
    minBetTo: s.streetLastBetTo + minInc,
    maxBetTo: s.streetLastBetTo + remaining,
  };
}

/** いまの局面がどのカテゴリか。 */
export function categoryOfSizing(s: SizingState): SizeCategory {
  const preflop = s.street === 0;
  // プリフロップは BB が既にベット扱いなので、「まだ誰もレイズしていない」は == BB。
  const facing = preflop ? s.streetLastBetTo > s.bb : s.streetLastBetTo > 0;
  if (preflop) return facing ? 'pfVsRaise' : 'pfOpen';
  return facing ? 'postVsBet' : 'postBet';
}

/**
 * プリセットを「そのストリートの累計ベット額（チップ）」へ解決する。
 * 合法範囲へのクランプまで済ませて返すので、そのまま送信額にできる。
 *
 * % の意味:
 *   ベット時   … いまのポットに対する比率
 *   レイズ時   … 「コールした後のポット」に対する上乗せ比率（100% = ポットレイズ）
 */
export function resolvePresetSizing(p: SizePreset, s: SizingState): number {
  const pot = s.pot;
  const call = callOfSizing(s);
  const top = s.streetLastBetTo;

  let raw: number;
  switch (p.unit) {
    case 'bb':
      raw = p.value * s.bb;
      break;
    case 'x':
      // 相手のベット額（そこまで）の倍率。まだ誰も張っていなければ BB 基準になる。
      raw = p.value * (top > 0 ? top : s.bb);
      break;
    case 'pct':
      raw = call > 0 ? top + ((pot + call) * p.value) / 100 : (pot * p.value) / 100;
      break;
  }
  return clampBetToSizing(Math.round(raw), s);
}

/** オールイン（Max）。 */
export function allInBetToSizing(s: SizingState): number {
  return legalOfSizing(s).maxBetTo;
}

/** 合法なベット額（そこまで）へ丸める。 */
export function clampBetToSizing(betTo: number, s: SizingState): number {
  const legal = legalOfSizing(s);
  if (!legal.canBet) return 0;
  return Math.min(legal.maxBetTo, Math.max(legal.minBetTo, Math.round(betTo)));
}

/**
 * スライダー/ステッパー用に「調整単位」の目盛りへ吸着させる。
 * 目盛りから外れる下限・上限だけは、そのまま端の値を許す（そこに合わせられないと
 * ミニマムレイズやオールインが選べなくなるため）。
 */
export function snapBetToSizing(betTo: number, s: SizingState, handleUnit: HandleUnit): number {
  const legal = legalOfSizing(s);
  if (!legal.canBet) return 0;
  const step = Math.max(1, Math.round(handleUnit * s.bb));
  const snapped = Math.round(betTo / step) * step;
  if (snapped <= legal.minBetTo) return legal.minBetTo;
  if (snapped >= legal.maxBetTo) return legal.maxBetTo;
  return snapped;
}

/** ステッパーの 1 ステップ（up=+1 / down=-1）。 */
export function stepBetToSizing(
  betTo: number,
  s: SizingState,
  handleUnit: HandleUnit,
  dir: 1 | -1,
): number {
  const legal = legalOfSizing(s);
  if (!legal.canBet) return 0;
  const step = Math.max(1, Math.round(handleUnit * s.bb));
  // 端に張り付いているときは、まず目盛りへ乗せてから動かす。
  const base = snapBetToSizing(betTo, s, handleUnit);
  const next = base === betTo ? betTo + dir * step : Math.round(base / step) * step + dir * step;
  return Math.min(legal.maxBetTo, Math.max(legal.minBetTo, next));
}

// ---------------------------------------------------------------------------
// Slumbot HU 向け後方互換ラッパー（HandState → SizingState の薄い変換）
// ---------------------------------------------------------------------------

/**
 * HU の `HandState` を `SizingState` へ変換する。`actingRemaining` は `stackOf`（rules.ts）
 * を使う。HU は毎ハンド両者スタック 20000 で揃うため、`legalActions()` が使う
 * `STACK − totalLastBetTo` 方式と本関数の値は常に数値一致する（sizes.test.ts で確認済み）。
 */
function fromHandState(s: HandState): SizingState {
  return {
    street: s.street,
    bb: BB,
    streetLastBetTo: s.streetLastBetTo,
    lastBetSize: s.lastBetSize,
    actingStreetBet: s.streetBet[s.toAct] ?? 0,
    actingRemaining: stackOf(s, s.toAct),
    pot: potOf(s),
  };
}

/** いまの局面がどのカテゴリか。 */
export function categoryOf(s: HandState): SizeCategory {
  return categoryOfSizing(fromHandState(s));
}

/** そのカテゴリのプリセット一覧。 */
export function presetsFor(cfg: BetSizeConfig, cat: SizeCategory): readonly SizePreset[] {
  return cfg[cat];
}

/**
 * プリセットを「そのストリートの累計ベット額（チップ）」へ解決する。
 * 合法範囲へのクランプまで済ませて返すので、そのまま b<N> にできる。
 */
export function resolvePreset(p: SizePreset, s: HandState): number {
  return resolvePresetSizing(p, fromHandState(s));
}

/** オールイン（Max）。 */
export function allInBetTo(s: HandState): number {
  return allInBetToSizing(fromHandState(s));
}

/** 合法なベット額（そこまで）へ丸める。 */
export function clampBetTo(betTo: number, s: HandState): number {
  return clampBetToSizing(betTo, fromHandState(s));
}

/**
 * スライダー/ステッパー用に「調整単位」の目盛りへ吸着させる。
 * 目盛りから外れる下限・上限だけは、そのまま端の値を許す（そこに合わせられないと
 * ミニマムレイズやオールインが選べなくなるため）。
 */
export function snapBetTo(betTo: number, s: HandState, handleUnit: HandleUnit): number {
  return snapBetToSizing(betTo, fromHandState(s), handleUnit);
}

/** ステッパーの 1 ステップ（up=+1 / down=-1）。 */
export function stepBetTo(
  betTo: number,
  s: HandState,
  handleUnit: HandleUnit,
  dir: 1 | -1,
): number {
  return stepBetToSizing(betTo, fromHandState(s), handleUnit, dir);
}

// ---- 設定の編集（設定モーダルから使う純関数） ----

export type EditResult =
  | { ok: true; config: BetSizeConfig }
  | { ok: false; message: string };

function sortPresets(list: readonly SizePreset[]): SizePreset[] {
  // 単位ごとにまとめ、その中は昇順（画像の並びと同じ見え方になる）。
  const order: Record<SizeUnit, number> = { bb: 0, x: 1, pct: 2 };
  return [...list].sort((a, b) => order[a.unit] - order[b.unit] || a.value - b.value);
}

/** プリセットを追加する。重複・上限・範囲はここで弾く。 */
export function addPreset(
  cfg: BetSizeConfig,
  cat: SizeCategory,
  unit: SizeUnit,
  value: number,
): EditResult {
  if (!CATEGORY_UNITS[cat].includes(unit)) return { ok: false, message: 'この項目では使えない単位です' };
  if (!Number.isFinite(value) || value <= 0) return { ok: false, message: '0 より大きい数を入れてください' };
  const v = Number(value.toFixed(2));
  const limit = unit === 'pct' ? 2000 : unit === 'x' ? 100 : 200;
  if (v > limit) return { ok: false, message: `大きすぎます（${limit} まで）` };
  const list = cfg[cat];
  if (list.length >= MAX_PRESETS) return { ok: false, message: `登録できるのは ${MAX_PRESETS} 個までです` };
  if (list.some((p) => p.unit === unit && p.value === v)) return { ok: false, message: 'すでに登録されています' };
  return { ok: true, config: { ...cfg, [cat]: sortPresets([...list, { unit, value: v }]) } };
}

/** プリセットを削除する。 */
export function removePreset(cfg: BetSizeConfig, cat: SizeCategory, index: number): BetSizeConfig {
  const list = cfg[cat];
  if (index < 0 || index >= list.length) return cfg;
  return { ...cfg, [cat]: list.filter((_, i) => i !== index) };
}

/** 1 カテゴリだけ既定へ戻す。 */
export function resetCategory(cfg: BetSizeConfig, cat: SizeCategory): BetSizeConfig {
  return { ...cfg, [cat]: DEFAULT_BET_SIZES[cat] };
}

// ---- 保存（端末ローカル） ----

const STORAGE_KEY = 'icm.slumbot.betSizes.v1';

function isPreset(v: unknown): v is SizePreset {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    (o.unit === 'bb' || o.unit === 'x' || o.unit === 'pct') &&
    typeof o.value === 'number' &&
    Number.isFinite(o.value) &&
    o.value > 0
  );
}

function readList(o: Record<string, unknown>, key: SizeCategory): readonly SizePreset[] {
  const raw = o[key];
  if (!Array.isArray(raw)) return DEFAULT_BET_SIZES[key];
  const list = raw.filter(isPreset).slice(0, MAX_PRESETS);
  return list;
}

/** 保存済み設定を読む（壊れていたら既定へ落とす＝設定画面が開けなくならない）。 */
export function loadBetSizes(store: Pick<Storage, 'getItem'> | null): BetSizeConfig {
  if (!store) return DEFAULT_BET_SIZES;
  let raw: string | null = null;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch {
    return DEFAULT_BET_SIZES;
  }
  if (!raw) return DEFAULT_BET_SIZES;
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const hu = HANDLE_UNITS.find((u) => u === o.handleUnit) ?? DEFAULT_BET_SIZES.handleUnit;
    return {
      handleUnit: hu,
      pfOpen: readList(o, 'pfOpen'),
      pfVsRaise: readList(o, 'pfVsRaise'),
      postBet: readList(o, 'postBet'),
      postVsBet: readList(o, 'postVsBet'),
    };
  } catch {
    return DEFAULT_BET_SIZES;
  }
}

export function saveBetSizes(store: Pick<Storage, 'setItem'> | null, cfg: BetSizeConfig): void {
  if (!store) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(cfg));
  } catch {
    /* プライベートブラウズ等で書けなくてもアプリは止めない。 */
  }
}
