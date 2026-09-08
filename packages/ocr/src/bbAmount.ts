/**
 * BB 表示（小数）モードの金額リーダ。SPEC §6.2。
 *
 * BB 表示ではスタック/ベット/ポットが "20.2 BB" / "13 BB"（整数値は小数点なし）で描かれ、
 * ヘッダの SB/BB・アンティだけは chips のまま（extract 側で別扱い）。chips モードとの違い:
 *  - 末尾に白文字 "BB" が付く（whiteMask が拾う）→ **スペース（最大ギャップ）で分離**して捨てる。
 *  - 小数点 "." は微小成分（実測 area≈42, h≈7, ベースライン）で、数字と整数の区別
 *    ("13"=13 か "1.3"=1.3 か)に必須 → 面積/高さの下限を下げて **必ず捕捉**する。
 *
 * 手順: whiteMask → 生 CCL（枠線/隅ノイズだけ除去）→ 左→右 → スペースで最初のクラスタ
 * （＝数値）を取り "BB" を捨てる → クラスタ内で背の低い成分は '.'、他は数字 NCC → parseAmount。
 *
 * chips 番号 "13,491" は連続一塊（スペース無し）＝ 1 クラスタなので、**2 クラスタに割れるか
 * どうか**が BB/chips の判別信号にもなる（hasBbSuffix / detectDisplayMode）。
 */

import type { DisplayMode, Gray, Rect, Read } from './types.js';
import type { Rgba } from './color.js';
import { crop, resize } from './raster.js';
import { bestMatch, matchConfidence, type Template } from './match.js';
import { parseAmount } from './digits.js';
import { grayFromRgba, whiteMask, DIGIT_NORM_H, type WhiteMaskOptions } from './numberField.js';

export interface BbAmountOptions extends WhiteMaskOptions {
  /** 数値の下限信頼度（未満なら低信頼フラグ）。既定 0.80。 */
  readonly confFloor?: number;
  /**
   * 桁受理の NCC 生スコア下限（未満の成分は数値組み立てから捨てる）。既定 0（無効＝旧挙動）。
   * 飾り（コーナー宝石/星）・端の 1px スリバー（隣プレート枠）・アイコン片（クラブ絵の 2 葉）は
   * 最良でも生スコア <0.35 で数字に化けるが、実桁は >=0.85 と明確に分離する
   * （実測: 飾り 0.09 / アイコン 0.20 / スリバー 0.32 vs 実桁 0.85-0.96）。stack/bet で 0.45 を渡すと
   * 先頭/末尾の偽桁を除去し "111.2"→"11.2" / "5.3"→"3" / ノイズのみ→NaN(bet=0) に落とす。
   * pot はセンター表示でこの種の縁ノイズが乗りにくく、既存の丸め込み(NaN 化で下流が棄却)を
   * 避けるため既定 0 のまま（呼び出し側が明示的に渡さない限り不変＝回帰なし）。
   */
  readonly scoreFloor?: number;
}

interface RawComp extends Rect {
  readonly area: number;
}

/** 生 CCL（面積/高さフィルタ無し, 4 近傍）。左→右。 */
function rawComponents(bin: Gray): RawComp[] {
  const { w, h, data } = bin;
  if (w === 0 || h === 0) return [];
  const label = new Int32Array(w * h).fill(-1);
  const boxes: { x0: number; y0: number; x1: number; y1: number; area: number }[] = [];
  const st: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (data[i] === 0 || label[i] !== -1) continue;
    const id = boxes.length;
    boxes.push({ x0: w, y0: h, x1: -1, y1: -1, area: 0 });
    st.length = 0; st.push(i); label[i] = id;
    while (st.length) {
      const p = st.pop()!;
      const px = p % w, py = (p / w) | 0;
      const b = boxes[id]!; b.area++;
      if (px < b.x0) b.x0 = px; if (px > b.x1) b.x1 = px;
      if (py < b.y0) b.y0 = py; if (py > b.y1) b.y1 = py;
      if (px > 0 && data[p - 1]! > 0 && label[p - 1] === -1) { label[p - 1] = id; st.push(p - 1); }
      if (px < w - 1 && data[p + 1]! > 0 && label[p + 1] === -1) { label[p + 1] = id; st.push(p + 1); }
      if (py > 0 && data[p - w]! > 0 && label[p - w] === -1) { label[p - w] = id; st.push(p - w); }
      if (py < h - 1 && data[p + w]! > 0 && label[p + w] === -1) { label[p + w] = id; st.push(p + w); }
    }
  }
  return boxes
    .map((b) => ({ x: b.x0, y: b.y0, w: b.x1 - b.x0 + 1, h: b.y1 - b.y0 + 1, area: b.area }))
    .sort((a, b) => a.x - b.x);
}

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

/**
 * 数字らしい生成分の共通フィルタ（枠線・隅ノイズ・幅広ブロブを除去）。
 * 除去: 面積 < 15 / 高さ < 5 / 幅がストリップ幅の 0.5 超（プレート枠線）/ w:h > 1.6（横線・ブロブ）。
 * h >= 0.9*領域高 は枠/手番グロー枠のエッジ（数字ではない）。h 下限は 4: folded/暗プレートで
 * 小数点 "." が薄くなり高さ 4px しか残らない場合がある（71.3→713 の欠落原因）。
 * area >= 15 で微小ノイズは除くので 4 でも安全。glyphComponents（クリーン読み）と
 * readAmountBb の弧較正（クリーンな兄弟グリフの検出）の両方で使う共通基準。
 */
function digitish(comps: readonly RawComp[], maskH: number, maskW: number): RawComp[] {
  return comps.filter(
    (c) => c.area >= 15 && c.h >= 4 && c.h < 0.9 * maskH && c.w <= 0.5 * maskW && c.w / c.h <= 1.6,
  );
}

/**
 * 数字＋小数点だけを残す（枠線・隅ノイズ・幅広ブロブ・背の高い飾りを除去）。
 * 標準グリフ高は tall 成分の中央値。標準グリフより十分高い成分は飾り（BL の宝石/星 h42 vs 数字 h26）。
 */
function glyphComponents(mask: Gray): RawComp[] {
  const base = digitish(rawComponents(mask), mask.h, mask.w);
  if (base.length === 0) return base;
  const maxH = Math.max(...base.map((c) => c.h));
  const glyphH = median(base.filter((c) => c.h >= 0.5 * maxH).map((c) => c.h));
  return base.filter((c) => c.h <= 1.4 * glyphH);
}


function normGlyph(strip: Gray, r: Rect): Gray {
  const g = crop(strip, r);
  const nw = Math.max(1, Math.round((g.w * DIGIT_NORM_H) / g.h));
  return resize(g, nw, DIGIT_NORM_H);
}

/**
 * 端に接する「幅広の白い横帯」（アバター発光弧・プレート下線）を薄く剥がす。弧も数字も白なので
 * 色では分離できないが、弧は端に接する高 fill の薄い帯（数字の上下端行は疎）なので幾何で剥がせる。
 * 端から連続して fill > bandFrac×幅 の行のみ黒化。各端は領域高の maxFrac（弧の想定厚み）までに
 * 厳しく制限し数字本体を食わない。帯が無ければ恒等（通常フレームは不変＝回帰なし）。
 */
function stripEdgeBands(mask: Gray, bandFrac = 0.5, maxFrac = 0.12): Gray {
  const { w, h, data } = mask;
  if (h < 8) return mask;
  const thr = bandFrac * w;
  const cap = Math.max(1, Math.floor(h * maxFrac));
  const rowFill = (y: number): number => { let c = 0; const row = y * w; for (let x = 0; x < w; x++) if (data[row + x]) c++; return c; };
  let top = 0; while (top < cap && rowFill(top) > thr) top++;
  let bot = 0; while (bot < cap && rowFill(h - 1 - bot) > thr) bot++;
  if (top === 0 && bot === 0) return mask;
  const out = new Uint8Array(data);
  for (let y = 0; y < top; y++) out.fill(0, y * w, y * w + w);
  for (let y = 0; y < bot; y++) out.fill(0, (h - 1 - y) * w, (h - 1 - y) * w + w);
  return { w, h, data: out };
}

/**
 * 成分を「弧ブリッジ刈り込み」する（iPhone コーナー席のアバター発光弧が先頭桁の上端に融合し
 * 幅広ブロブ化する問題への対策。exp_band.ts の readBand で iOS 12/12・Android 65/66（現行と同一
 * ＝回帰なし）を確認済みの手法をそのまま移植）。
 *
 * 列ごとに縦方向の最大連続ラン長を求め、長さ >= N を「支持あり」とする。ギャップ <= 2N は
 * 同一クラスタへ橋渡し（グリフ内部の曲線起因の穴を跨ぐが、無関係に離れた弧の残骸までは跨がない）。
 * 最初（最も左）のクラスタだけを採用し、そこから外の部分（弧の残り／クロップ右端付近で接線が
 * 急峻になり列単独では「弧なのに縦ランが長い」偽陽性を起こす箇所）を切り捨てる。
 * 画素内容は元マスク（開放前）から再取得するので、"9" の輪や "B" の腹のような細いストローク
 * （弧の厚みと同オーダー）を千切らずに済む。クラスタが見つからなければ元の成分をそのまま返す。
 */
function trimArcBridge(mask: Gray, c: RawComp, N: number): RawComp {
  const { w, h, data } = mask;
  const y0 = Math.max(0, c.y - 1), y1 = Math.min(h, c.y + c.h + 1);
  const supported: boolean[] = new Array(c.w).fill(false);
  for (let xi = 0; xi < c.w; xi++) {
    const x = c.x + xi;
    let run = 0, maxRun = 0;
    for (let y = y0; y < y1; y++) {
      if (data[y * w + x]) { run++; if (run > maxRun) maxRun = run; } else run = 0;
    }
    supported[xi] = maxRun >= N;
  }
  const R = N;
  const clusters: { x0: number; x1: number }[] = [];
  let curStart = -1, lastTrue = -1;
  for (let xi = 0; xi < c.w; xi++) {
    if (supported[xi]) { if (curStart < 0) curStart = xi; lastTrue = xi; }
    else if (curStart >= 0 && xi - lastTrue > 2 * R) { clusters.push({ x0: curStart, x1: lastTrue }); curStart = -1; }
  }
  if (curStart >= 0) clusters.push({ x0: curStart, x1: lastTrue });
  if (clusters.length === 0) return c;
  const first = clusters[0]!;
  const nx0 = c.x + first.x0, nx1 = c.x + first.x1 + 1;
  let ny0 = h, ny1 = 0, area = 0;
  for (let x = nx0; x < nx1; x++) for (let y = y0; y < y1; y++) if (data[y * w + x]) { area++; if (y < ny0) ny0 = y; if (y + 1 > ny1) ny1 = y + 1; }
  if (ny1 <= ny0) return c;
  return { x: nx0, y: ny0, w: nx1 - nx0, h: ny1 - ny0, area };
}

/**
 * BB 表示の金額を読む（"20.2 BB" → 20.2, "13 BB" → 13）。値は表示どおり **BB**（正規化不要）。
 * templates は数字 0-9（'.' は成分の低さで判定するのでテンプレ不要）。
 * 数字が無ければ value=NaN, conf=0。
 *
 * 接尾辞 "BB" の切り離しは **NCC アンカー**（`letters` に "B" テンプレを渡す）で行う。
 * 旧実装は「末尾 tall 2 個＝BB」と位置決め打ちだったため、席の右にある UI 装飾
 * （手番シェブロン ▼ 等）が余分な tall 成分を作ると BB でなく装飾を切ってしまい、
 * "BB" を数字 "88" として採用する誤読が起きた（実 iPhone TR 27.7→17.788）。
 * letters があれば最初の英字（"B"）で数値を打ち切り、以降（BB・シェブロン・名前）を捨てる。
 * letters が無い場合は従来どおり大きなギャップで数値末尾を推定する。
 *
 * さらに、先頭桁がアバターの発光リング/弧（iPhone コーナー席）に融合し幅広ブロブ化して
 * glyphComponents 相当の w/h<=1.6 フィルタで丸ごと落とされるケース（実 iPhone TL "19.2"→"9"、
 * "21.2"→"11.2" 相当の誤読）を **弧ブリッジ刈り込み**（trimArcBridge, exp_band.ts の readBand で
 * iOS 12/12・Android 65/66=現行同等 を確認済みの手法）で数字として復元する。
 * 刈り込みは「幅広ブロブ（w/h>1.6）または典型幅の 1.35 倍超」という **suspect ゲート**を通った
 * 成分にしか適用しない（フックだけの小さな融合で比率はまだ壊れていないケースも拾うため 1.35 倍
 * 判定も使うが、通常のクリーンな数字はどちらの条件にも掛からず刈り込み関数自体を一切通らない
 * ＝クリーン読みは旧実装とビット互換）。
 */
export function readAmountBb(
  img: Rgba,
  rect: Rect,
  templates: readonly Template[],
  opts: BbAmountOptions = {},
  letters?: readonly Template[],
): Read<number> {
  const minCh = opts.minCh ?? 120;
  const maxSat = opts.maxSat ?? 80;
  const strip = grayFromRgba(img, rect);
  const mask = stripEdgeBands(whiteMask(img, rect, { minCh, maxSat }));
  const rawAll = rawComponents(mask);

  // ---- 較正: クリーンな（弧に融合していない）兄弟グリフから glyphH・normalW（"1" 以外の典型幅）を推定 ----
  const preClean = digitish(rawAll, mask.h, mask.w);
  let glyphH: number;
  let normalW: number;
  if (preClean.length > 0) {
    const maxHc = Math.max(...preClean.map((c) => c.h));
    const tallOnes = preClean.filter((c) => c.h >= 0.5 * maxHc);
    glyphH = median(tallOnes.map((c) => c.h));
    normalW = median(tallOnes.map((c) => c.w));
  } else {
    // クリーンな兄弟が皆無（全桁が弧に融合等）→ ストリップ高から粗く見積もる。
    glyphH = rawAll.length > 0 ? Math.max(...rawAll.map((c) => c.h)) : Math.round(mask.h * 0.7);
    normalW = glyphH * 0.8;
  }
  // N: 弧の想定厚み（実測 2-6px）より上、実数字ストローク高より下にクランプ。
  let N = Math.round(0.35 * glyphH);
  N = Math.max(4, Math.min(N, Math.max(4, glyphH - 3)));

  // ---- 弧ブリッジ刈り込み: suspect（幅広ブロブ or 典型幅の1.35倍超）な成分だけ trimArcBridge を通す ----
  const salvaged: RawComp[] = [];
  for (const c of rawAll) {
    if (c.area < 15 || c.h < 4 || c.h >= 0.9 * mask.h || c.w > 0.5 * mask.w) continue;
    const needsTrim = c.w / c.h > 1.6 || c.w > 1.35 * normalW;
    const use = needsTrim ? trimArcBridge(mask, c, N) : c;
    if (use.area >= 15 && use.h >= 4 && use.w / use.h <= 1.6) salvaged.push(use);
  }
  salvaged.sort((a, b) => a.x - b.x);
  const gValid = salvaged.filter((c) => c.h <= 1.4 * glyphH);
  if (gValid.length === 0) return { value: NaN, conf: 0 };

  const maxH2 = Math.max(...gValid.map((c) => c.h));
  const tallCut = 0.45 * maxH2;
  const tall = gValid.filter((c) => c.h >= tallCut);
  if (tall.length < 3) return { value: NaN, conf: 0 }; // 数字 1 個 ＋ "BB" 未満は読めない

  // 末尾 "BB" の位置を **letters NCC**（右端の隣接 "B" ペア）で特定する。席の右にある UI 装飾
  // （手番シェブロン ▼ 等）が BB の右に余分な tall 成分を作っても、BB ペア以降を数値スパンから
  // 外せる。旧実装の「末尾 tall 2 個＝BB」決め打ちは、その装飾を BB と誤って落とし、本物の BB を
  // 数字 "88" として採用していた（実 iPhone TR 27.7→17.788 の主因）。B ペアが見つからない場合
  // （B の誤読・ベット帯で B が数字化する等）は **旧来どおり末尾 tall 2 個を BB** とみなす
  // ＝クリーンなフレームでは挙動不変（回帰なし）。
  const isB = (c: RawComp): boolean =>
    letters !== undefined && bestMatch(normGlyph(strip, c), [...templates, ...letters]).label === 'B';
  let suffixStart = -1;
  if (letters) for (let i = tall.length - 1; i >= 1; i--) if (isB(tall[i]!) && isB(tall[i - 1]!)) { suffixStart = i - 1; break; }
  const numTall = suffixStart >= 0 ? tall.slice(0, suffixStart) : tall.slice(0, tall.length - 2);
  if (numTall.length === 0) return { value: NaN, conf: 0 };
  const firstX = numTall[0]!.x;
  const lastTall = numTall[numTall.length - 1]!;
  const lastX = lastTall.x + lastTall.w;
  const digitBottom = median(numTall.map((c) => c.y + c.h));

  // ---- 小数点は刈り込みで消えうる（w/h<=1.6 の最終フィルタで弧の残骸ごと落ちる場合がある）ので、
  // gValid ではなく **生マスクの小成分**（背が低い・面積小・ベースライン付近・数値スパン内）から
  // 別途拾い、x 座標で数字列の隙間へ挿し込む。 ----
  const dots = rawAll.filter(
    (c) =>
      c.h <= 0.45 * glyphH &&
      c.h >= 2 &&
      c.area >= 4 &&
      c.x >= firstX - 2 &&
      c.x + c.w <= lastX + 2 &&
      Math.abs(c.y + c.h - digitBottom) <= 0.3 * glyphH,
  );

  type Item = { readonly x: number; readonly dot: boolean; readonly comp: RawComp };
  const items: Item[] = [
    ...numTall.map((c) => ({ x: c.x, dot: false, comp: c })),
    ...dots.map((c) => ({ x: c.x, dot: true, comp: c })),
  ].sort((a, b) => a.x - b.x);

  const scoreFloor = opts.scoreFloor ?? 0; // 既定 0＝旧挙動（呼び出し側が明示した席のみ有効）
  let text = '';
  let minScore = 1;
  for (const it of items) {
    if (it.dot) {
      text += '.'; // 小数点
      continue;
    }
    const m = bestMatch(normGlyph(strip, it.comp), templates);
    if (m.score < scoreFloor) continue; // 飾り/スリバー/アイコン片を桁として採用しない
    text += m.label;
    const s = matchConfidence(m);
    if (s < minScore) minScore = s;
  }
  const value = parseAmount(text);
  if (value === null) return { value: NaN, conf: 0 };
  let conf = Math.max(0, Math.min(1, minScore));
  // 刈り込み後もなお左端(x<=2)に幅広 tall 塊が残る＝弧が刈りきれなかった残留ブリッジ。低信頼フラグ
  // して確認画面で強調 → 利用者修正に回す（サイレントな高信頼誤読を防ぐ）。gValid は既に
  // w/h<=1.6 を満たす成分のみなのでこの条件（w/h>2.0）は通常発生しないが、将来の閾値変更に
  // 対する保険として残す（exp_band.ts の readBand と同じ設計）。
  const stillClipped = gValid.some((c) => c.x <= 2 && c.h >= 0.7 * maxH2 && c.w / c.h > 2.0);
  if (stillClipped) conf = Math.min(conf, 0.4);
  return { value, conf };
}

/**
 * 名前アンカー方式の BB スタック読取（ディレクタの two-anchor 設計）。SPEC §6.2 拡張。
 *
 * 目的（ローカライズの頑健化）: BB 表示の席近傍には "BB" が複数現れうる——(1) スタックの "BB"
 * （数字の直後・黄色名の直上）, (2) **BB ポジションの紫バッジ**（アバター左上）, (3) テーブル felt 上の
 * 白い "BB" 位置ラベル（左下）, (4) 隣席のスタック "BB"（広域クロップの端）。現行 readAmountBb は
 * タイトに較正した stack 矩形＋「最右の BB ペア」で (1) を正しく取れているが、矩形がドリフト/拡大
 * すると (2)(3) がクロップに入り、バッジの "BB" が数字化して誤読する（例 "12.9"→"8812.9"）。
 *
 * 実測（scripts/_probeNA2, Android GT 20枚＋iPhone GT 2枚 の bb 席）で判別子は明快:
 *   - stack-BB は **直左に数字を持つ**（digitLeft=40/40, 数字→BBの隙間 <~2 グリフ幅）。
 *   - バッジ/felt/隣席の "BB" は **直左に数字を持たない**（15/15）。
 *   - stack-BB は黄色名の中心に最も近い（dx/Nh∈[-1.05,+4.59]）, バッジ/felt は遠く左（dx/Nh∈[-8.93,-3.89]）。
 * よって選択規則は「**直左に数字の連続塊を持つ BB トークンのうち、黄色名中心に最も近いもの**」。
 * その BB の**直左の連続数字塊だけ**を数値スパンにする（バッジ由来の左方 B を数字に化けさせない）。
 *
 * これは readAmountBb の「最右 BB ペア＋その左の全 tall」より広域ノイズに強い。**安全策**として
 * extract は現行 readAmountBb を主とし、これは NaN 時のフォールバックにのみ使う（クリーン席は
 * 現行パスのまま＝ビット不変・回帰なし）。stackRect は現行と同じ席矩形を渡し、この関数が内部で
 * 左方（バッジ側）へ広げて探索する。nameCx（黄色名中心 x, 画像絶対 px）が与えられればアンカーに使う。
 */
export function readAmountBbAnchored(
  img: Rgba,
  stackRect: Rect,
  templates: readonly Template[],
  opts: BbAmountOptions = {},
  letters?: readonly Template[],
  nameCx?: number,
): Read<number> {
  const minCh = opts.minCh ?? 120;
  const maxSat = opts.maxSat ?? 80;
  // 探索領域: 矩形がどちら向きにドリフトしても stack を含むよう左右対称に広げる（ドリフトは
  // 対称なので左右非対称だと片方向で stack を外す＝drift 掃引で実証）。上下は stack 近傍に留め、
  // 上のカード pip・下の名前を帯外へ落とす。バッジ（左上）・felt/隣席の "BB" は領域に入りうるが
  // 「直左に数字」判別子＋名前アンカーで stack-BB だけを選ぶ。whiteMask は画像外を内部クランプ。
  const left = Math.round(stackRect.w * 1.5);
  const right = Math.round(stackRect.w * 0.7);
  const up = Math.round(stackRect.h * 0.6);
  const down = Math.round(stackRect.h * 0.6);
  const region: Rect = { x: stackRect.x - left, y: stackRect.y - up, w: stackRect.w + left + right, h: stackRect.h + up + down };

  const strip = grayFromRgba(img, region);
  const mask = stripEdgeBands(whiteMask(img, region, { minCh, maxSat }));
  const rawAll = rawComponents(mask);

  // 広域領域では card pip 等の**背の高い白ブロブ**が混じるため、readAmountBb の
  // 「median 高さで較正」だと glyphH が pip 側へ引っ張られ数字が全滅する。そこで**尺度は BB の
  // "B" 高さ**に委ねる（BB→数字の高さは rigid ＝同一, sd 0.022 の実証; SPEC §6.2 冒頭）。まず通常
  // グリフ（w/h<=1.6）だけを NCC 分類し、隣接 B,B ペアを見つけ、その B 高さ gh を基準に直左の
  // 連続数字塊を採る（高さ [0.6,1.5]gh・同一ベースライン）。pip は 'B'/数字に化けても高さで弾かれる。
  const lset = letters ?? [];
  const narrow = rawAll
    .filter((c) => c.area >= 15 && c.h >= 6 && c.h < 0.9 * mask.h && c.w <= 0.5 * mask.w && c.w / c.h <= 1.6)
    .sort((a, b) => a.x - b.x);
  if (narrow.length < 3) return { value: NaN, conf: 0 };
  const labeled = narrow.map((c) => {
    const m = bestMatch(normGlyph(strip, c), [...templates, ...lset]);
    return { c, label: m.label, score: m.score };
  });
  const isDigit = (l: string): boolean => l.length === 1 && l >= '0' && l <= '9';

  // BB トークン列挙。各トークンの B 高さ gh を尺度に、直左の連続数字塊を集める。
  interface Cand { digitRun: number[]; gh: number; bbX0: number; bbBottom: number; cx: number }
  const cands: Cand[] = [];
  for (let i = 0; i + 1 < labeled.length; i++) {
    const a = labeled[i]!, b = labeled[i + 1]!;
    if (a.label !== 'B' || b.label !== 'B' || a.score < 0.5 || b.score < 0.5) continue;
    const gh = (a.c.h + b.c.h) / 2;
    if (Math.abs(a.c.h - b.c.h) > 0.35 * gh) continue; // 同程度の高さ
    if (b.c.x - (a.c.x + a.c.w) > 0.9 * gh) continue; // BB は近接
    const bbBottom = (a.c.y + a.c.h + b.c.y + b.c.h) / 2;
    if (Math.abs((a.c.y + a.c.h) - (b.c.y + b.c.h)) > 0.3 * gh) continue; // 同一ベースライン
    const run: number[] = [];
    let ref = a.c.x;
    for (let k = i - 1; k >= 0; k--) {
      const g = labeled[k]!;
      if (ref - (g.c.x + g.c.w) > 1.2 * gh) break; // 大きな隙間＝数値の左端（バッジまでは届かない）
      // 背の低い成分（小数点候補・NCC で数字ラベルに化けても桁ではない）はスキップして左へ継続。
      if (g.c.h < 0.6 * gh) { ref = g.c.x; continue; }
      if (!isDigit(g.label)) break; // 背の高い非数字（隣の B 等）で打ち切り
      if (g.c.h > 1.5 * gh) break; // 数字高は B 高と同程度（rigid）
      if (Math.abs(g.c.y + g.c.h - bbBottom) > 0.35 * gh) break; // 同一ベースライン
      run.unshift(k);
      ref = g.c.x;
    }
    if (run.length === 0) continue; // 直左に数字が無い＝バッジ/felt/隣席（判別子）→除外
    const firstC = labeled[run[0]!]!.c;
    cands.push({ digitRun: run, gh, bbX0: a.c.x, bbBottom, cx: (firstC.x + a.c.x) / 2 + region.x });
    i++; // ペア消費
  }
  if (cands.length === 0) return { value: NaN, conf: 0 };

  // 選択: 名前中心に最も近い候補。nameCx が無ければ最右（stack は最右, バッジは左）。
  const chosen = nameCx !== undefined
    ? cands.reduce((best, c) => (Math.abs(c.cx - nameCx) < Math.abs(best.cx - nameCx) ? c : best))
    : cands.reduce((best, c) => (c.cx > best.cx ? c : best));

  const gh = chosen.gh;
  let N = Math.round(0.35 * gh);
  N = Math.max(4, Math.min(N, Math.max(4, gh - 3)));
  const numTall: RawComp[] = chosen.digitRun.map((k) => labeled[k]!.c);
  // 先頭桁がアバター発光弧に融合し幅広ブロブ化して narrow から漏れるケース（iOS コーナー
  // "19.2"→"9.2"）: 現行 run の左に、弧刈り込みで数字化できる幅広ブロブがあれば復元して前置。
  {
    const leftX = numTall[0]!.x;
    let blob: RawComp | null = null;
    for (const c of rawAll) {
      if (c.w / c.h <= 1.6) continue; // 幅広のみ
      if (c.h < 0.7 * gh || c.h > 1.8 * gh) continue;
      if (c.x + c.w > leftX + 2 || leftX - (c.x + c.w) > 1.2 * gh) continue; // run の直左
      if (Math.abs(c.y + c.h - chosen.bbBottom) > 0.5 * gh) continue;
      if (!blob || c.x > blob.x) blob = c;
    }
    if (blob) {
      const t = trimArcBridge(mask, blob, N);
      if (t.area >= 15 && t.h >= 0.6 * gh && t.w / t.h <= 1.6) numTall.unshift(t);
    }
  }
  numTall.sort((a, b) => a.x - b.x);
  const firstX = numTall[0]!.x;
  const lastTall = numTall[numTall.length - 1]!;
  const lastX = lastTall.x + lastTall.w;
  const digitBottom = median(numTall.map((c) => c.y + c.h));

  // 小数点は生マスクの小成分から拾う（readAmountBb と同一の基準, gh を尺度に）。
  const dots = rawAll.filter(
    (c) =>
      c.h <= 0.45 * gh &&
      c.h >= 2 &&
      c.area >= 4 &&
      c.x >= firstX - 2 &&
      c.x + c.w <= lastX + 2 &&
      Math.abs(c.y + c.h - digitBottom) <= 0.3 * gh,
  );

  type Item = { readonly x: number; readonly dot: boolean; readonly comp: RawComp };
  const items: Item[] = [
    ...numTall.map((c) => ({ x: c.x, dot: false, comp: c })),
    ...dots.map((c) => ({ x: c.x, dot: true, comp: c })),
  ].sort((a, b) => a.x - b.x);

  const scoreFloor = opts.scoreFloor ?? 0;
  let text = '';
  let minScore = 1;
  for (const it of items) {
    if (it.dot) { text += '.'; continue; }
    const m = bestMatch(normGlyph(strip, it.comp), templates);
    if (m.score < scoreFloor) continue;
    text += m.label;
    const s = matchConfidence(m);
    if (s < minScore) minScore = s;
  }
  const value = parseAmount(text);
  if (value === null) return { value: NaN, conf: 0 };
  return { value, conf: Math.max(0, Math.min(1, minScore)) };
}

/**
 * スタックの末尾 2 背高成分が "B","B" か（＝BB 表示）を NCC で確認。SPEC §6.2 のモード判定。
 * digits＋letters（"B"）でマッチし、末尾 2 tall が両方 'B' なら true。chips は数字で終わるので false。
 * 実画像 hero 101/101 で chips/BB を完全分離（ピッチ判定より確実）。成分 3 未満は false。
 */
export function stackEndsWithBb(
  img: Rgba,
  rect: Rect,
  digitTemplates: readonly Template[],
  letterTemplates: readonly Template[],
  opts: WhiteMaskOptions = {},
): boolean {
  const minCh = opts.minCh ?? 120;
  const maxSat = opts.maxSat ?? 80;
  const strip = grayFromRgba(img, rect);
  const comps = glyphComponents(whiteMask(img, rect, { minCh, maxSat }));
  if (comps.length < 3) return false;
  const maxH = Math.max(...comps.map((c) => c.h));
  const tall = comps.filter((c) => c.h >= 0.45 * maxH);
  if (tall.length < 3) return false;
  const all = [...digitTemplates, ...letterTemplates];
  const last2 = tall.slice(-2);
  return last2.every((c) => bestMatch(normGlyph(strip, c), all).label === 'B');
}

/**
 * フレームの数値表示モードを判定（'bb' | 'chips'）。SPEC §6.2。
 * hero スタックが最もクリーンなので主判定に使い、読めなければ他の occupied 席を順に見る。
 * どの席も読めなければ chips（既定）にフォールバック。
 */
export function detectDisplayMode(
  img: Rgba,
  stackRects: readonly Rect[],
  digitTemplates: readonly Template[],
  letterTemplates: readonly Template[],
  opts: WhiteMaskOptions = {},
): DisplayMode {
  for (const rect of stackRects) {
    const comps = glyphComponents(whiteMask(img, rect, { minCh: opts.minCh ?? 120, maxSat: opts.maxSat ?? 80 }));
    if (comps.length < 3) continue; // 空席/読めない席は飛ばす
    return stackEndsWithBb(img, rect, digitTemplates, letterTemplates, opts) ? 'bb' : 'chips';
  }
  return 'chips';
}
