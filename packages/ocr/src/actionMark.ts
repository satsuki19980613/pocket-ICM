/**
 * アクションマーク認識（フォールドを含む 5 語）。さつき決定 2026-09-10。
 *
 * ポーカーチェイスは**行動した瞬間に席のアバター上へ吹き出しプレートを出す**。プリフロップに
 * 出るのは フォールド / コール / レイズ / オールイン（ポストフロップに チェック）。実測
 * （Screenshot_20260902-114640.png は 4 席のマークが同時に見える）で、**マークは消えずに
 * 行動した席ぶん残る**ことを確認した。したがって「誰が何をしたか」はマークを読めば確定する。
 *
 * 従来 `cardState.ts` は**カード裏の色**（青が明るい＝生存 / 暗い＝降りた）で fold を判定していたが、
 * カード裏はユーザーが着せ替えられる。淡色のキャラ絵スキンを着けた実機フレーム
 * （Screenshot_20260910-192316.png）では全席が「降りた」と誤判定され、ブラインドまで 0 に
 * なった。マークはゲーム側の UI で着せ替え対象ではないので、こちらが正しい主信号。
 *
 * ## なぜ `actionTag.ts` では読めなかったか（実測）
 * プレートは 2 状態ある。同じ形・同じ大きさで、**明るさだけが違う**:
 *   - 能動（コール/レイズ/オールイン/チェック）: 明るい紫の地・**白く発光する縁**・**白文字**
 *   - フォールド: 暗い紫の地・**灰色の縁**・**灰色の文字**（実測 RGB ≈ 128〜176）
 * `actionTag.ts` は固定しきい値の白文字マスク（minCh 125〜150）で文字を取るので、
 * フォールドの灰文字は落ちる（実測: minCh150 で 0 px）。しきい値を下げても、こんどは能動側で
 * 背景を拾う。**固定しきい値では両方を同時に満たせない**のが根本原因だった。
 *
 * ## 本モジュールの方法（サブエージェント計測 2026-09-10・フォールド16例/能動14例/マーク無し30例）
 * 1. プレートの footprint を**明るい低彩度マスク**（縁＋文字が 1 つの塊になる）の連結成分から取る。
 *    縁は能動＝白／フォールド＝灰でどちらも「明るい低彩度」なので、この 1 本の基準で両対応できる。
 * 2. その矩形の中で **Otsu**（`raster.otsuThreshold`）を取り、明るい側を文字インクとする。
 *    実測しきい値はフォールド 61〜73 / 能動 126〜137 と大きく違うが、Otsu が各インスタンスで
 *    自動的に合わせるので、**インク率は 0.19〜0.39 / 0.20〜0.27 とほぼ同じ**になる。これで
 *    1 組の NCC テンプレで 5 語を同じ土俵で比較できる。
 * 3. 正規化して 5 語テンプレに NCC。
 * 4. **誤検出側に厳しい 3 重ゲート**をかける（現行バグは「動いていないのに動いたと読む」
 *    偽陽性ばかりだったので、取りこぼしよりも偽陽性を潰す方を優先する）。判定順にコード側と揃える:
 *      a. インク率がプレートらしい範囲
 *      b. NCC 信頼度が床以上
 *      c. **一致した語のクラスとプレートの彩度が整合**（fold は低彩度・能動は高彩度）。
 *         プレート内 meanSat はフォールド 17.6〜46.1 / 能動 61.2〜79.2 で重なりが無い（差 15.1）。
 *         背景がたまたま語形に似ても、彩度まで一致しなければ弾ける。
 * どれかを外したら 'none'（＝まだ行動していない）を高信頼で返す。
 */

import type { Gray, Read, Rect, SeatAction } from './types.js';
import type { Rgba } from './color.js';
import { bestMatch, matchConfidence, type Template } from './match.js';
import { whiteMask, grayFromRgba } from './numberField.js';
import { binarize, otsuThreshold, resize } from './raster.js';

/** 語テンプレの正規化高さ（幅はアスペクト維持）。`actionTag.ts` と同値。 */
export const MARK_NORM_H = 32;

/** マークの語 label → SeatAction。`actionTag.ACTION_WORDS` に フォールド を加えたもの。 */
export const MARK_WORDS: Record<string, SeatAction> = {
  'フォールド': 'fold',
  'レイズ': 'raise',
  'コール': 'call',
  'オールイン': 'allin',
  'チェック': 'check',
};

/** 語がフォールド（＝暗く沈んだプレート）かどうか。ゲート c の判定に使う。 */
function isDimWord(action: SeatAction): boolean {
  return action === 'fold';
}

export interface ActionMarkOptions {
  /** プレート探索マスクの最小チャンネル値。既定 100（灰の縁も拾う）。 */
  readonly plateMinCh?: number;
  /** プレート探索マスクの許容彩度。既定 90。 */
  readonly plateMaxSat?: number;
  /**
   * プレート幅の期待値（画像幅比）。既定 0.054。
   *
   * 実測（いずれも `normalizeForAnchors` 後の正規化画像に対する比）: Android 2730×1260 で
   * 149px = 0.055、iOS 1792×828（正規化後 2264×1046）で 117px = 0.052、薔薇テーマ卓で
   * 141px/2730 = 0.052。
   *
   * 枠線ランの許容長さはこの値から決める（探索帯の幅からではなく）。帯を広げてもここが
   * 変わらないので、テーマ差でプレートが動いても帯だけ広げれば追従できる。
   */
  readonly plateWFrac?: number;
  /** 枠線と認めるラン長さの許容比（plateW 比）。既定 0.70〜1.40。 */
  readonly runLoFactor?: number;
  readonly runHiFactor?: number;
  /** プレートの縦横比 h/w。既定 0.36（実測 54/149, 56/155, 42/117）。 */
  readonly plateHOverW?: number;
  /** 上下枠線の間隔が期待値からどれだけずれても許すか（期待高さ比）。既定 0.45。 */
  readonly plateHTolerance?: number;
  /** インク率の許容範囲。既定 0.10〜0.55（実測 0.19〜0.39 / 0.20〜0.27 に余裕を持たせた）。 */
  readonly inkMin?: number;
  readonly inkMax?: number;
  /**
   * fold プレートと認める平均彩度の帯。既定 25〜49。
   * 実測（GT 157 席）: 本物の fold は 38.3〜43.2。単一のしきい値ではなく**帯**にするのが要点 ——
   * hero 席の常設装飾（スタックの金枠）が彩度 55.2〜62.5 のプレート状矩形を作り、しきい値
   * 方式だと「fold より上だから能動」と解釈されて偽陽性になった（実測 30 件）。
   */
  readonly foldSatMin?: number;
  readonly foldSatMax?: number;
  /**
   * 能動プレートと認める平均彩度の下限。既定 68（実測: 本物の能動 75.0〜90.0 / 偽陽性の上限 62.5）。
   * 49〜68 は「どちらでもない」死角として捨てる。
   */
  readonly activeSatMin?: number;
  /** これ未満の NCC 信頼度なら 'none' 扱い。既定 0.45。 */
  readonly confFloor?: number;
}

export interface MarkPlate {
  /** フレーム px のプレート矩形（縁を含む）。 */
  readonly rect: Rect;
  /** 矩形内の平均彩度（max−min チャンネル）。fold/能動の判別に使う。 */
  readonly meanSat: number;
}

/** 矩形内の平均彩度（max−min チャンネル）。 */
export function meanSaturation(img: Rgba, rect: Rect): number {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(img.w, x0 + rect.w);
  const y1 = Math.min(img.h, y0 + rect.h);
  const w = Math.max(0, x1 - x0), h = Math.max(0, y1 - y0);
  if (w === 0 || h === 0) return 0;
  let sum = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = ((y0 + y) * img.w + (x0 + x)) * 4;
      const R = img.data[s]!, G = img.data[s + 1]!, B = img.data[s + 2]!;
      sum += Math.max(R, G, B) - Math.min(R, G, B);
    }
  return sum / (w * h);
}

/** 1 行の最長連続ラン。 */
function longestRun(mask: Gray, y: number): { len: number; start: number } {
  let best = 0, bestStart = 0, cur = 0, curStart = 0;
  for (let x = 0; x < mask.w; x++) {
    if (mask.data[y * mask.w + x]! > 0) {
      if (cur === 0) curStart = x;
      cur++;
      if (cur > best) { best = cur; bestStart = curStart; }
    } else cur = 0;
  }
  return { len: best, start: bestStart };
}

/**
 * 探索帯の中からプレート矩形を取る。無ければ null。
 *
 * **プレートの上下の枠線が横一直線に走る**という形状の性質を使う。フォールドは灰の枠線、
 * 能動は白く発光する枠線で、どちらも「明るい低彩度」マスクに乗る（実測: minCh 100 で
 * 両方の枠線が出る）。連結成分の最大値を採る素朴な方法は使えない —— フォールドの枠線は
 * マスク上で四隅が切れて**リングにならず**、最大成分が文字の一部（実測 72×22）になって
 * しまい、能動（連続した白リング＝プレート全体）と框の定義が食い違う。横一直線を基準に
 * すれば両クラスで**同じ定義の矩形**が取れる。
 *
 * 手順:
 *  1. 各行の最長ランを測り、長さが**プレート幅の 0.70〜1.40 倍**に入る行を枠線候補とする。
 *     プレート幅は画像幅比（既定 0.054）で与える固定値 —— 探索帯の幅ではなく実寸を基準に
 *     するのが要点。テーマによって席が内側へ寄る（実測: 薔薇テーマ卓は TR/BR が 0.027 内寄り）
 *     ので帯は広く取りたいが、帯幅比だと帯を広げた分だけ判定が緩んで背景を拾ってしまう。
 *     この窓は上のバナー（アンティ/プリフロップの帯・幅 0.15 ＝ プレートの 2.8 倍）も自動で外す。
 *  2. 候補行を縦に固まりへまとめる（枠線は数 px の厚み）。
 *  3. **固まりのペア**のうち、上下間隔がプレート比 h/w=0.36 から求まる期待値に最も近いものを
 *     採る。素朴に「最上と最下」を採ると、アバターの明るい髪の塊を下枠と誤認して高さが
 *     1.7 倍に伸びる（実測: TL のレイズで 0.042 → 0.070）。
 *  4. 妥当なペアが無ければ 1 本だけ使い、プレート比でもう一方を補う（下枠がアバターに隠れる等）。
 */
export function locateMarkPlate(img: Rgba, searchRect: Rect, opts: ActionMarkOptions = {}): MarkPlate | null {
  const x0 = Math.max(0, Math.floor(searchRect.x));
  const y0 = Math.max(0, Math.floor(searchRect.y));
  const mask = whiteMask(img, searchRect, {
    minCh: opts.plateMinCh ?? 100,
    maxSat: opts.plateMaxSat ?? 90,
  });
  if (mask.w === 0 || mask.h === 0) return null;
  const plateW = (opts.plateWFrac ?? 0.054) * img.w;
  const minLen = (opts.runLoFactor ?? 0.70) * plateW;
  const maxLen = (opts.runHiFactor ?? 1.40) * plateW;
  const hOverW = opts.plateHOverW ?? 0.36;

  // 1. 枠線候補の行。
  const rows: { y: number; len: number; start: number }[] = [];
  for (let y = 0; y < mask.h; y++) {
    const r = longestRun(mask, y);
    if (r.len >= minLen && r.len <= maxLen) rows.push({ y, len: r.len, start: r.start });
  }
  if (rows.length === 0) return null;

  // 2. 縦に連続する行を固まりにまとめる（枠線は数 px の厚みを持つ）。
  const groups: { y0: number; y1: number; xs: number; xe: number }[] = [];
  for (const r of rows) {
    const last = groups[groups.length - 1];
    if (last && r.y - last.y1 <= 2) {
      last.y1 = r.y;
      last.xs = Math.min(last.xs, r.start);
      last.xe = Math.max(last.xe, r.start + r.len);
    } else {
      groups.push({ y0: r.y, y1: r.y, xs: r.start, xe: r.start + r.len });
    }
  }

  // 3. 上下枠線のペアを、間隔が期待値に最も近いもので選ぶ。
  let yTop = 0, yBot = 0, xs = 0, xe = 0;
  let bestErr = Infinity;
  for (let i = 0; i < groups.length; i++)
    for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i]!, b = groups[j]!;
      const w = Math.max(a.xe, b.xe) - Math.min(a.xs, b.xs);
      const expect = hOverW * w;
      const err = Math.abs(b.y1 - a.y0 - expect);
      if (err <= (opts.plateHTolerance ?? 0.45) * expect && err < bestErr) {
        bestErr = err;
        yTop = a.y0; yBot = b.y1;
        xs = Math.min(a.xs, b.xs); xe = Math.max(a.xe, b.xe);
      }
    }
  if (bestErr === Infinity) {
    // 4. 妥当なペアが無い: 最も長いランの固まりを 1 本の枠線として使う。
    let g = groups[0]!;
    for (const c of groups) if (c.xe - c.xs > g.xe - g.xs) g = c;
    xs = g.xs; xe = g.xe;
    const h = Math.round(hOverW * (xe - xs));
    if ((g.y0 + g.y1) / 2 < mask.h / 2) { yTop = g.y0; yBot = g.y0 + h; }
    else { yBot = g.y1; yTop = g.y1 - h; }
  }
  // 5. 上枠を基準に、プレートの**既定のアスペクト**へ矩形を正規化する。
  //    プレートは固定サイズのアセットなので、下枠の実測（アバターの髪や光に汚れて数 px 揺れる）
  //    より h/w=0.36 を信じるほうが正確で、なにより**全候補・全テンプレで縦横比が一定**になる。
  //    NCC は正規化後の像を比べるので、ここが揺れると同じ語でも幅が 89px と 79px に分かれて
  //    一致率が落ちる（実測: TL のレイズ/コールで発生）。yBot は妥当性検査にだけ使う。
  void yBot;
  const w = xe - xs;
  const h = Math.round(hOverW * w);
  // 正規化した矩形が帯に収まらないなら null を返す（クランプしない）。クランプすると
  // 「見つけた枠線と繋がっていない・縦横比も崩れた矩形」を返してしまい、下流の Otsu と NCC が
  // 黙って別物を見る。帯はプレートの約 2.4 倍あるので、収まらないのは帯の位置自体がずれて
  // いる（＝この席の読みを信じるべきでない）ケース。'none' に落ちるほうが安全。
  if (w <= 0 || h <= 0 || xs < 0 || yTop < 0 || xs + w > mask.w || yTop + h > mask.h) return null;
  const rect: Rect = { x: x0 + xs, y: y0 + yTop, w, h };
  return { rect, meanSat: meanSaturation(img, rect) };
}

/**
 * プレート矩形 → 文字インクマスク（Otsu, 明るい側が前景）。
 *
 * 固定しきい値ではなく Otsu を使うのが要点。フォールドと能動でプレートの絶対輝度が
 * 大きく違う（実測しきい値 61〜73 / 126〜137）が、Otsu は各インスタンスで地とインクの
 * 分離点を自分で見つけるので、出力のインク率が両クラスで揃う。
 */
export function markInkMask(img: Rgba, plateRect: Rect): Gray {
  const g = grayFromRgba(img, plateRect);
  return binarize(g, otsuThreshold(g), false);
}

/** インクマスクの前景率。 */
function inkFraction(mask: Gray): number {
  let on = 0;
  for (let i = 0; i < mask.data.length; i++) if (mask.data[i]! > 0) on++;
  return mask.data.length === 0 ? 0 : on / mask.data.length;
}

/** インクマスクを高さ MARK_NORM_H に正規化（幅はアスペクト維持）。 */
export function normMark(mask: Gray): Gray {
  const nw = Math.max(1, Math.round((mask.w * MARK_NORM_H) / Math.max(1, mask.h)));
  return resize(mask, nw, MARK_NORM_H);
}

/** 認識の内訳（較正・診断用。本番は value/conf だけ使う）。 */
export interface MarkDiag {
  readonly plate: MarkPlate | null;
  readonly ink: number;
  readonly label: string;
  readonly rawConf: number;
  /** 落ちたゲート（'plate' | 'ink' | 'conf' | 'sat'）。通れば undefined。 */
  readonly rejected?: 'plate' | 'ink' | 'conf' | 'sat';
}

/**
 * 席の探索帯 → アクションマーク。マークが無ければ 'none'（高信頼）。
 *
 * `templates` の label は MARK_WORDS のキー（フォールドを含む 5 語）。テンプレは
 * `scripts/genActionMarks.ts` が**本モジュールと同じ経路**（locateMarkPlate → markInkMask →
 * normMark）で切り出す。テンプレと候補の作り方を一致させることが NCC の前提。
 */
export function recognizeMark(
  img: Rgba,
  searchRect: Rect,
  templates: readonly Template[],
  opts: ActionMarkOptions = {},
): Read<SeatAction> {
  return recognizeMarkDiag(img, searchRect, templates, opts).read;
}

/** `recognizeMark` の内訳付き版（テンプレ生成・しきい値較正のため export する）。 */
export function recognizeMarkDiag(
  img: Rgba,
  searchRect: Rect,
  templates: readonly Template[],
  opts: ActionMarkOptions = {},
): { read: Read<SeatAction>; diag: MarkDiag } {
  const none: Read<SeatAction> = { value: 'none', conf: 0.9 };
  const plate = locateMarkPlate(img, searchRect, opts);
  if (!plate) return { read: none, diag: { plate: null, ink: 0, label: '', rawConf: 0, rejected: 'plate' } };

  const mask = markInkMask(img, plate.rect);
  const ink = inkFraction(mask);
  const m = bestMatch(normMark(mask), templates);
  const conf = matchConfidence(m);
  const diagBase = { plate, ink, label: m.label, rawConf: conf };

  if (ink < (opts.inkMin ?? 0.10) || ink > (opts.inkMax ?? 0.55)) {
    return { read: none, diag: { ...diagBase, rejected: 'ink' } };
  }
  if (conf < (opts.confFloor ?? 0.45)) {
    return { read: none, diag: { ...diagBase, rejected: 'conf' } };
  }
  const action = MARK_WORDS[m.label];
  if (!action) return { read: none, diag: { ...diagBase, rejected: 'conf' } };

  // ゲート c: 語のクラスとプレートの彩度が整合しているか。fold は沈んだプレート（低彩度帯）、
  // 能動は鮮やかなプレート（高彩度）。どちらの帯にも入らない矩形は背景／装飾なので落とす。
  const sat = plate.meanSat;
  const satOk = isDimWord(action)
    ? sat >= (opts.foldSatMin ?? 25) && sat <= (opts.foldSatMax ?? 49)
    : sat >= (opts.activeSatMin ?? 68);
  if (!satOk) return { read: none, diag: { ...diagBase, rejected: 'sat' } };
  return { read: { value: action, conf }, diag: diagBase };
}
