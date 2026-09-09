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
 * フレーム単位で active/folded 判定に使う指標（metric/threshold）を自動選択する（機種プロファイルに
 * 依存しない純関数）。extractAnchored.ts のアンカー抽出経路は固定座標プロファイル（FrameProfile）を
 * 経由しないため機種が分からない。代わりに **フレーム内の全席の blueFractions を先に集め**、その
 * 分布から Android 系（明るい青で切れる）か iOS 系（沈んだ青で切れる）かを判別する。
 *
 * 実測（本番アンカー経路の cardRect, ディレクター計測 + 本実装時の再計測）:
 *  - Android（2730×1260, GT 20 フレーム）: active strong 0.4274〜0.5883・bright 0.2999〜0.4186、
 *    folded strong 0.0000〜0.4777・bright は**例外なく 0.0000**。→ bright でしか切れない
 *    （folded でも strong が 0.48 まで上がりうるため strong は使えない）。
 *  - iOS（1792×828, 2 フレーム）: active strong 0.2023/0.2561/0.2751/0.3461・bright は基本 0.0000 だが、
 *    1 席（EC7CD106 の TR, active）だけ bright=0.0905 の残留信号が出た（アンチエイリアス起因の微小
 *    ノイズと見られる）。folded strong 0.0000/0.0000/0.0889・bright 0.0000。
 *    → strong は active 最小 0.2023 と folded 最大 0.0889 の間（閾値 0.15）できれいに分離できる。
 *    bright は iOS では信号として使えない（0 が基本だが上のノイズのように 0.06 をわずかに超える席が
 *    ある＝「1 席でも bright≥0.06」を判別の境界に使うと、この 1 席のノイズだけでフレーム全体を
 *    誤って Android 系と判定し、bright=0 の他の active 席（このノイズ元と同フレームの TL/TC/BL）を
 *    fold と誤判定する連鎖が起きた（実装中に発覚・実測で確認）。
 *
 * 判別法: 対象席（hero を除く・nameBox がある占有席）のいずれか 1 席でも **bright ≥ 0.15** を出せば
 * Android 系と判断する。閾値は「Android の active bright 実測最小 0.2999」と「iOS の残留ノイズ実測
 * 最大 0.0905」の中間に置き、ノイズ 1 席で誤判定しない余裕を持たせた（isActiveHand 適用時の既定
 * 閾値 0.06 とは別物 — 0.06 はあくまで「Android 系と判った後に bright で active/folded を分ける」
 * 閾値、0.15 は「そもそも Android 系かどうかを判別する」閾値）。Android 系と判ったら各席
 * `active = bright >= 0.06`（現状の既定と同一＝回帰ゼロ）。判別で Android 系に届かなければ iOS 系の
 * 沈んだ描画とみなし、各席 `active = strong >= 0.15` を使う。
 * 対象席が 1 つも無い（フォールドウォーク等で非 hero 占有席が判定不能）場合は、判別材料が無いので
 * 従来どおり既定の bright/0.06 にフォールバックする（＝回帰ゼロ）。
 */
const ANDROID_SIGNAL_BRIGHT = 0.15;
export function pickHandActiveRule(fracs: readonly BlueFractions[]): { metric: 'bright' | 'strong'; threshold: number } {
  if (fracs.length === 0) return { metric: 'bright', threshold: 0.06 };
  const androidSignal = fracs.some((f) => f.bright >= ANDROID_SIGNAL_BRIGHT);
  return androidSignal ? { metric: 'bright', threshold: 0.06 } : { metric: 'strong', threshold: 0.15 };
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
