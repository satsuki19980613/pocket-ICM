/**
 * アクションラベル認識（レイズ/コール/オールイン/チェック）。SPEC §6.3 #3。
 *
 * リプレイのプリフロップ終了フレームでは各席の近く（アバター上）に紫プレートの行動タグが
 * 出る。能動タグ（レイズ/コール/オールイン/チェック）は**明るい白文字**なので、席の探索帯で
 * 「明・低彩度」の文字マスク（数字と同じ whiteMask を流用）を取り、文字量が閾値以上なら
 * その外接矩形をグレースケール正規化して 4 語テンプレに NCC する。文字が少なければ 'none'。
 *
 * **フォールドはここでは扱わない**（フォールドタグは灰色文字で背景と分離しにくい）。フォールドと
 * 占有（empty）は抽出層でカード裏の状態（無＝empty / 青＝active / 灰＝folded）から判定し、
 * この能動タグ結果と合流させて最終 SeatAction を作る（extract 層）。
 *
 * 手番中インジケータ（名前プレート周りの赤/水色グロー）はアクションではないが、探索帯を
 * アバター上（プレート位置）に限るのでグローには反応しない。
 *
 * テンプレは実スクショから初回生成（SPEC §10, 非同梱）。実画像しきい値は dev harness で較正。
 */

import type { Read, Rect, SeatAction } from './types.js';
import type { Rgba } from './color.js';
import { bestMatch, matchConfidence, type Template } from './match.js';
import { whiteMask, binaryComponents } from './numberField.js';
import { resize } from './raster.js';

/** 語テンプレの正規化高さ（幅はアスペクト維持）。 */
export const ACTION_NORM_H = 32;

/** 能動タグの語 label → SeatAction（fold はカード状態から別途）。 */
export const ACTION_WORDS: Record<string, SeatAction> = {
  'レイズ': 'raise',
  'コール': 'call',
  'オールイン': 'allin',
  'チェック': 'check',
};

export interface ActionTagOptions {
  /** 文字マスクの最小チャンネル値。既定 125（白文字を拾い紫背景を除く）。 */
  readonly minCh?: number;
  /** 文字マスクの許容彩度。既定 70。 */
  readonly maxSat?: number;
  /** タグ有りと判定する最小文字面積（探索帯面積比）。既定 0.25（能動 0.40+, none 0.15-）。 */
  readonly minTextAreaFrac?: number;
  /** これ未満の NCC 信頼度なら曖昧として 'none' 扱い。既定 0.4。 */
  readonly confFloor?: number;
}

export interface TagBox {
  /** フレーム px の文字外接矩形。 */
  readonly rect: Rect;
  /** 文字成分の総面積（bbox 和）。 */
  readonly area: number;
}

/**
 * 探索帯の白文字外接矩形（フレーム px）。文字量が閾値未満なら null。
 *
 * 語だけを安定して切り出すため、連結成分を x 方向のギャップでクラスタリングし
 * （同一語の文字間ギャップは小、離れたノイズは別クラスタ）、**最大面積クラスタ**の
 * 外接矩形を採る。これで探索帯を多少広げても bbox が語に一致し、正規化後の NCC が安定する。
 */
export function findTagBox(img: Rgba, searchRect: Rect, opts: ActionTagOptions = {}): TagBox | null {
  const minCh = opts.minCh ?? 125;
  const maxSat = opts.maxSat ?? 70;
  const x0 = Math.max(0, Math.floor(searchRect.x));
  const y0 = Math.max(0, Math.floor(searchRect.y));
  const mask = whiteMask(img, searchRect, { minCh, maxSat });
  const comps = binaryComponents(mask).slice().sort((a, b) => a.x - b.x);
  if (comps.length === 0) return null;
  // x ギャップでクラスタリング（語内の文字間 < ギャップ閾値 < 語とノイズ間）。
  const gapMax = 0.6 * mask.h; // 文字高の 0.6 倍を語内ギャップ上限とする
  const clusters: { comps: typeof comps; area: number; x0: number; y0: number; x1: number; y1: number }[] = [];
  let cur: (typeof clusters)[number] | null = null;
  for (const c of comps) {
    if (cur && c.x - cur.x1 <= gapMax) {
      cur.comps.push(c); cur.area += c.w * c.h;
      cur.x0 = Math.min(cur.x0, c.x); cur.y0 = Math.min(cur.y0, c.y);
      cur.x1 = Math.max(cur.x1, c.x + c.w); cur.y1 = Math.max(cur.y1, c.y + c.h);
    } else {
      cur = { comps: [c], area: c.w * c.h, x0: c.x, y0: c.y, x1: c.x + c.w, y1: c.y + c.h };
      clusters.push(cur);
    }
  }
  let best = clusters[0]!;
  for (const cl of clusters) if (cl.area > best.area) best = cl;
  const zoneArea = Math.max(1, searchRect.w * searchRect.h);
  if (best.area / zoneArea < (opts.minTextAreaFrac ?? 0.25)) return null;
  return { rect: { x: x0 + best.x0, y: y0 + best.y0, w: best.x1 - best.x0, h: best.y1 - best.y0 }, area: best.area };
}

/**
 * 文字矩形を高さ ACTION_NORM_H に正規化。**二値テキストマスク**（whiteMask）を正規化する
 * ので背景（紫プレート）に不変で字形が際立ち、語の判別が安定する。
 */
export function normTag(img: Rgba, box: Rect, opts: ActionTagOptions = {}): ReturnType<typeof resize> {
  const minCh = opts.minCh ?? 125;
  const maxSat = opts.maxSat ?? 70;
  const m = whiteMask(img, box, { minCh, maxSat });
  const nw = Math.max(1, Math.round((m.w * ACTION_NORM_H) / Math.max(1, m.h)));
  return resize(m, nw, ACTION_NORM_H);
}

/**
 * 席の探索帯 → 能動アクション `Read<SeatAction>`。文字タグが無ければ 'none'（高信頼）。
 * fold は含まない（カード状態から別途）。wordTemplates の label は ACTION_WORDS のキー。
 */
export function recognizeAction(
  img: Rgba,
  searchRect: Rect,
  wordTemplates: readonly Template[],
  opts: ActionTagOptions = {},
): Read<SeatAction> {
  const box = findTagBox(img, searchRect, opts);
  if (box === null) return { value: 'none', conf: 0.9 };
  const m = bestMatch(normTag(img, box.rect, opts), wordTemplates);
  const conf = matchConfidence(m);
  const action = ACTION_WORDS[m.label] ?? 'none';
  // 低信頼（曖昧マッチ/ノイズ）は none 扱いにして誤検出を避ける。
  if (conf < (opts.confFloor ?? 0.4)) return { value: 'none', conf: 0.9 };
  return { value: action, conf };
}
