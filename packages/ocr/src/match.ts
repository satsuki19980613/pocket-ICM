/**
 * テンプレートマッチ中核（正規化相互相関 NCC）。
 *
 * ポーカーチェイスは描画フォント・カードデザインが固定なので、学習器ではなく
 * テンプレートマッチで足りる（SPEC §6.3）。NCC は輝度のオフセット・スケールに
 * 不変なので、装飾品や軽い明度差に頑健。テンプレは実スクショから生成するが
 * （後続）、マッチ演算自体はここで確定・検証する。
 */

import type { Gray } from './types.js';
import { meanStd, resize } from './raster.js';

/**
 * 正規化相互相関（同サイズ）。返り値 [-1,1]。1 が完全一致。
 * どちらかの標準偏差が 0（平坦）なら 0 を返す。
 */
export function ncc(a: Gray, b: Gray): number {
  if (a.w !== b.w || a.h !== b.h) {
    throw new RangeError(`ncc size mismatch: ${a.w}x${a.h} vs ${b.w}x${b.h}`);
  }
  const n = a.data.length;
  if (n === 0) return 0;
  const ma = meanStd(a);
  const mb = meanStd(b);
  if (ma.std === 0 || mb.std === 0) return 0;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += (a.data[i]! - ma.mean) * (b.data[i]! - mb.mean);
  }
  return acc / (n * ma.std * mb.std);
}

export interface Template {
  readonly label: string;
  readonly img: Gray;
}

export interface MatchResult {
  readonly label: string;
  /** 最良 NCC スコア [-1,1]。 */
  readonly score: number;
  /** 2 位との差（曖昧さの指標。大きいほど確信）。 */
  readonly margin: number;
  readonly index: number;
}

/**
 * 候補パッチを各テンプレサイズへ揃えて NCC を取り、最良を返す。
 * テンプレは同一サイズ前提でなくてよい（各テンプレのサイズに候補を resize）。
 */
export function bestMatch(candidate: Gray, templates: readonly Template[]): MatchResult {
  if (templates.length === 0) throw new RangeError('templates must not be empty');
  let best = -Infinity;
  let second = -Infinity;
  let bestLabel = templates[0]!.label;
  let bestIdx = 0;
  for (let i = 0; i < templates.length; i++) {
    const t = templates[i]!;
    const cand = candidate.w === t.img.w && candidate.h === t.img.h
      ? candidate
      : resize(candidate, t.img.w, t.img.h);
    const s = ncc(cand, t.img);
    if (s > best) {
      second = best;
      best = s;
      bestLabel = t.label;
      bestIdx = i;
    } else if (s > second) {
      second = s;
    }
  }
  const margin = second === -Infinity ? 0 : best - second;
  return { label: bestLabel, score: best, margin, index: bestIdx };
}

/**
 * NCC スコア [-1,1] と 2 位マージンから信頼度 [0,1] を作る。
 * score を [0,1] に折り、マージンで軽くブースト（曖昧なら減点）。
 */
export function matchConfidence(m: MatchResult): number {
  const base = Math.max(0, m.score); // 負相関は 0
  const marginBoost = Math.min(0.15, Math.max(0, m.margin) * 0.5);
  return Math.min(1, base * 0.9 + marginBoost);
}
