/**
 * アクションタグ認識の合成テスト（画像非依存）。実画像は dev harness（probeAction/probeAlign）で
 * 密着帯なら 4 語 conf 1.00 を確認済み（6 席帯の較正・多例収集は較正課題として別途）。
 * ここでは「文字マスク→主クラスタ bbox→NCC、プレート無し=none、低信頼=none」を固定する。
 */
import { describe, it, expect } from 'vitest';
import type { Rgba } from './color.js';
import type { Rect } from './types.js';
import type { Template } from './match.js';
import { findTagBox, recognizeAction, normTag, ACTION_WORDS, type ActionTagOptions } from './actionTag.js';

// 合成語は帯に対して小さいので面積しきい値を下げる（実画像の 0.25 は tight zone 前提）。
const OPTS: ActionTagOptions = { minTextAreaFrac: 0.03, confFloor: 0.3 };

/** 紫プレート地に白の「文字」矩形群を描く。stripes=各文字の縦帯パターン（1=描画）。 */
function renderWord(cols: number[], opts: { x?: number; noise?: boolean } = {}): { img: Rgba; rect: Rect } {
  const W = 220, H = 60;
  const data = new Uint8Array(W * H * 4);
  // 紫背景（min ch 低・彩度高 → whiteMask で除外）。
  for (let i = 0; i < W * H; i++) { data[i * 4] = 100; data[i * 4 + 1] = 45; data[i * 4 + 2] = 130; data[i * 4 + 3] = 255; }
  const x0 = opts.x ?? 40, y0 = 18, ch = 26;
  cols.forEach((on, k) => {
    if (!on) return;
    const cx = x0 + k * 10;
    for (let y = 0; y < ch; y++) for (let x = 0; x < 6; x++) {
      const s = ((y0 + y) * W + (cx + x)) * 4; data[s] = 240; data[s + 1] = 240; data[s + 2] = 240;
    }
  });
  return { img: { w: W, h: H, data }, rect: { x: 0, y: 0, w: W, h: H } };
}

// 2 つの識別可能な「語」パターン（縦帯の有無列）。
const WORD_A = [1, 1, 0, 1, 1, 0, 1, 1]; // "レイズ" に見立てる
const WORD_B = [1, 0, 1, 0, 1, 0, 1, 0]; // "コール" に見立てる

function templateFrom(cols: number[], label: string): Template {
  const { img, rect } = renderWord(cols);
  const box = findTagBox(img, rect, OPTS)!;
  return { label, img: normTag(img, box.rect) };
}
const templates: Template[] = [templateFrom(WORD_A, 'レイズ'), templateFrom(WORD_B, 'コール')];

describe('findTagBox', () => {
  it('紫地の白文字クラスタの外接矩形を返す', () => {
    const { img, rect } = renderWord(WORD_A);
    const box = findTagBox(img, rect, OPTS);
    expect(box).not.toBeNull();
    expect(box!.rect.w).toBeGreaterThan(20);
  });
  it('文字が無い（紫だけ）なら null', () => {
    const W = 100, H = 40; const data = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) { data[i * 4] = 100; data[i * 4 + 1] = 45; data[i * 4 + 2] = 130; data[i * 4 + 3] = 255; }
    expect(findTagBox({ w: W, h: H, data }, { x: 0, y: 0, w: W, h: H }, OPTS)).toBeNull();
  });
});

describe('recognizeAction', () => {
  it('語をラベル対応の SeatAction にする', () => {
    const { img, rect } = renderWord(WORD_A);
    const r = recognizeAction(img, rect, templates, OPTS);
    expect(r.value).toBe(ACTION_WORDS['レイズ']); // 'raise'
    expect(r.conf).toBeGreaterThan(0.5);
  });
  it('別の語は別の action', () => {
    const { img, rect } = renderWord(WORD_B);
    expect(recognizeAction(img, rect, templates, OPTS).value).toBe(ACTION_WORDS['コール']); // 'call'
  });
  it('プレート（文字）が無ければ none', () => {
    const W = 100, H = 40; const data = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) { data[i * 4] = 100; data[i * 4 + 1] = 45; data[i * 4 + 2] = 130; data[i * 4 + 3] = 255; }
    const r = recognizeAction({ w: W, h: H, data }, { x: 0, y: 0, w: W, h: H }, templates, OPTS);
    expect(r.value).toBe('none');
  });
});
