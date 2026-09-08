/**
 * カード裏の状態から「hand が生きているか（active）／降りたか（folded）」を判定。SPEC §6.3 #3 補助。
 *
 * このゲームのカード裏は青デザイン。**手番が生きている席は鮮やかな明るい青**、**降りた席は
 * 暗い紺**に沈む（実画像で確認: active の明るい青画素比 0.13-0.28, folded は 0.00）。よって
 * カード領域の「明るい青」画素比で active/folded を分ける。フォールドタグ（灰文字）は
 * actionTag では分離しにくいので、フォールドはこのカード状態で判定するのが堅い。
 *
 * 占有（empty）は暗い紺と青系背景が重なり色だけでは切れないため、抽出層で **スタック数字の
 * 有無**（recognizeAmount が読めるか）と併せて確定する（empty＝カードも数字も無い）。
 *
 * 実画像検証（dev harness, AI 目視 vs 指標, 142844 のエージェント誤ラベルを実物照合で訂正）:
 * active/folded の分離は brightBlue 閾値 0.06 で全サンプル一致。
 */

import type { Read, Rect } from './types.js';
import type { Rgba } from './color.js';

export interface BlueFractions {
  /** 真の青（B>R+strongMargin かつ B>G）の画素比。カード（active/folded とも）で高い。 */
  readonly strong: number;
  /** 明るい真の青（B>brightB）の画素比。active でのみ高い。 */
  readonly bright: number;
}

export interface CardStateOptions {
  /** 真の青の R 差マージン（B > R + strongMargin）。既定 50（紫背景 B≈R を除外）。 */
  readonly strongMargin?: number;
  /** 明るい青の B 下限。既定 150。 */
  readonly brightB?: number;
  /** active と判定する青画素比のしきい値。既定 metric='bright' で 0.06 / 'strong' で 0.05。 */
  readonly activeFrac?: number;
  /**
   * active 判定に使う指標。機種依存（FrameProfile が指定）:
   *  - 'bright'（既定・Android）: 明るい青比。Android は active で高く（0.13-0.28）folded は≈0。
   *  - 'strong'（iOS）: 真の青比。iOS は active カードの明るい青がほぼ無い（bright≈0）が、真の青は
   *    薄く残る（active strong≈0.10-0.14 / folded strong≈0.001）。iOS folded は Android と違い
   *    strong も低いので strong で分離できる（Android は folded でも strong 高＝bright が必須）。
   */
  readonly metric?: 'bright' | 'strong';
}

/** カード領域の青画素比（strong / bright）。 */
export function blueFractions(img: Rgba, cardRect: Rect, opts: CardStateOptions = {}): BlueFractions {
  const sm = opts.strongMargin ?? 50;
  const bb = opts.brightB ?? 150;
  const x0 = Math.max(0, Math.floor(cardRect.x));
  const y0 = Math.max(0, Math.floor(cardRect.y));
  const x1 = Math.min(img.w, x0 + cardRect.w);
  const y1 = Math.min(img.h, y0 + cardRect.h);
  const w = Math.max(0, x1 - x0), h = Math.max(0, y1 - y0);
  if (w === 0 || h === 0) return { strong: 0, bright: 0 };
  let strong = 0, bright = 0;
  const n = w * h;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = ((y0 + y) * img.w + (x0 + x)) * 4;
      const R = img.data[s]!, G = img.data[s + 1]!, B = img.data[s + 2]!;
      if (B > R + sm && B > G + 30) { strong++; if (B > bb) bright++; }
    }
  return { strong: strong / n, bright: bright / n };
}

/**
 * カード領域 → hand が active か（生きているか）。明るい青が閾値以上なら active。
 * conf は閾値からの距離。folded/empty は false（両者の区別は占有＝スタック有無で行う）。
 */
export function isActiveHand(img: Rgba, cardRect: Rect, opts: CardStateOptions = {}): Read<boolean> {
  const fr = blueFractions(img, cardRect, opts);
  const metric = opts.metric ?? 'bright';
  const val = metric === 'strong' ? fr.strong : fr.bright;
  const thr = opts.activeFrac ?? (metric === 'strong' ? 0.05 : 0.06);
  const active = val >= thr;
  // active は指標が閾値の 2 倍で conf~0.9、folded は指標≈0 で conf~0.9。
  const conf = active
    ? Math.min(0.95, 0.6 + (val - thr) * 3)
    : Math.min(0.95, 0.7 + (thr - val) * 3);
  return { value: active, conf: Math.max(0, Math.min(1, conf)) };
}
