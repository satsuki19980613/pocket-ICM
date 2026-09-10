/**
 * アクションマーク認識の合成テスト（画像非依存）。
 *
 * 実画像での成績は dev ハーネスで実測済み（`scripts/evalActionMarks.ts`: 正解ラベル付き
 * 157 席・5 解像度・2 テーマで 157/157、偽陽性 0）。ここでは実画像に依存せず、
 * 設計上の不変量を固定する:
 *   - プレートは**上下の枠線（横一直線）**で見つける（フォールドの灰枠でも能動の白枠でも同じ）
 *   - 二値化はプレート内 **Otsu**（フォールドの絶対輝度が低くても同じインク率になる）
 *   - プレートが無ければ 'none'
 *   - 偽陽性ゲート: インク率・NCC 信頼度・**プレート彩度と語クラスの整合**
 */
import { describe, it, expect } from 'vitest';
import type { Rgba } from './color.js';
import type { Rect } from './types.js';
import type { Template } from './match.js';
import {
  locateMarkPlate,
  markInkMask,
  normMark,
  recognizeMark,
  recognizeMarkDiag,
  meanSaturation,
  MARK_NORM_H,
  MARK_WORDS,
  type ActionMarkOptions,
} from './actionMark.js';

const W = 400, H = 200;
/** プレートは 100×36（h/w = 0.36）。フレーム幅比 0.25 を opts で渡す。 */
const PLATE = { x: 150, y: 80, w: 100, h: 36 };
const OPTS: ActionMarkOptions = { plateWFrac: PLATE.w / W };
const ZONE: Rect = { x: 120, y: 55, w: 160, h: 90 };

interface PlateStyle {
  /** 地の色（彩度がクラス判定に効く）。 */
  readonly fill: readonly [number, number, number];
  /** 枠線と文字の色（明るい低彩度）。 */
  readonly ink: readonly [number, number, number];
}
/** フォールド: 沈んだ地＋灰の枠線・灰文字（実測 meanSat 38〜43）。 */
const FOLD: PlateStyle = { fill: [60, 40, 85], ink: [150, 150, 150] };
/** 能動: 鮮やかな地＋白く発光する枠線・白文字（実測 meanSat 75〜90）。 */
const ACTIVE: PlateStyle = { fill: [110, 30, 150], ink: [250, 250, 250] };
/** 彩度が fold 帯と能動帯の“死角”に入る地（hero 席の常設装飾がこの帯に出る・実測 55〜62）。 */
const DEADZONE: PlateStyle = { fill: [95, 45, 130], ink: [200, 200, 200] };

function blank(): Uint8Array {
  const data = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = 20; data[i * 4 + 1] = 25; data[i * 4 + 2] = 30; data[i * 4 + 3] = 255;
  }
  return data;
}

function fillRect(data: Uint8Array, r: Rect, c: readonly [number, number, number]): void {
  for (let y = 0; y < r.h; y++)
    for (let x = 0; x < r.w; x++) {
      const s = ((r.y + y) * W + (r.x + x)) * 4;
      data[s] = c[0]; data[s + 1] = c[1]; data[s + 2] = c[2]; data[s + 3] = 255;
    }
}

/**
 * 吹き出しプレートを描く。`stripes` は文字に見立てた縦帯の有無列。
 * 枠線は 3px（ゲームの実物も上下に横一直線の枠線を持つ）。
 */
function renderPlate(
  stripes: readonly number[],
  style: PlateStyle,
  plate: Rect = PLATE,
  base: Uint8Array = blank(),
): Rgba {
  fillRect(base, plate, style.ink); // 枠線
  fillRect(base, { x: plate.x + 3, y: plate.y + 3, w: plate.w - 6, h: plate.h - 6 }, style.fill);
  stripes.forEach((on, k) => {
    if (!on) return;
    fillRect(base, { x: plate.x + 12 + k * 10, y: plate.y + 10, w: 5, h: 16 }, style.ink);
  });
  return { w: W, h: H, data: base };
}

// 2 つの識別可能な「語」パターン。
const WORD_FOLD = [1, 1, 0, 1, 1, 0, 1];
const WORD_RAISE = [1, 0, 1, 0, 1, 0, 1];

function templateFrom(stripes: readonly number[], style: PlateStyle, label: string): Template {
  const img = renderPlate(stripes, style);
  const plate = locateMarkPlate(img, ZONE, OPTS)!;
  return { label, img: normMark(markInkMask(img, plate.rect)) };
}
const templates: Template[] = [
  templateFrom(WORD_FOLD, FOLD, 'フォールド'),
  templateFrom(WORD_RAISE, ACTIVE, 'レイズ'),
];

describe('locateMarkPlate', () => {
  it('上下の枠線からプレート矩形を取る（能動＝白枠）', () => {
    const plate = locateMarkPlate(renderPlate(WORD_RAISE, ACTIVE), ZONE, OPTS);
    expect(plate).not.toBeNull();
    expect(plate!.rect.x).toBeCloseTo(PLATE.x, -1);
    expect(plate!.rect.y).toBeCloseTo(PLATE.y, -1);
    expect(plate!.rect.w).toBeCloseTo(PLATE.w, -1);
  });

  it('フォールド（灰枠・灰文字）でも同じ矩形が取れる', () => {
    const a = locateMarkPlate(renderPlate(WORD_FOLD, FOLD), ZONE, OPTS)!;
    const b = locateMarkPlate(renderPlate(WORD_FOLD, ACTIVE), ZONE, OPTS)!;
    expect(a.rect).toEqual(b.rect);
  });

  it('高さは w×0.36 に正規化する（下枠が汚れても縦横比が一定）', () => {
    const plate = locateMarkPlate(renderPlate(WORD_RAISE, ACTIVE), ZONE, OPTS)!;
    expect(plate.rect.h).toBe(Math.round(0.36 * plate.rect.w));
  });

  it('プレートが無ければ null', () => {
    expect(locateMarkPlate({ w: W, h: H, data: blank() }, ZONE, OPTS)).toBeNull();
  });

  it('下枠がアバターに隠れて上枠だけでも、プレート比から矩形を補う', () => {
    // 上枠だけを残し、下枠は塗り潰して消す（実物ではアバターの髪が下枠を覆う）。
    const data = blank();
    fillRect(data, PLATE, ACTIVE.ink);
    fillRect(data, { x: PLATE.x + 3, y: PLATE.y + 3, w: PLATE.w - 6, h: PLATE.h }, ACTIVE.fill);
    const plate = locateMarkPlate({ w: W, h: H, data }, ZONE, OPTS);
    expect(plate).not.toBeNull();
    expect(plate!.rect.y).toBeCloseTo(PLATE.y, -1);
    expect(plate!.rect.h).toBe(Math.round(0.36 * plate!.rect.w));
  });

  it('正規化した矩形が帯に収まらないなら null（ずれた矩形を返さない）', () => {
    // 帯の高さをプレート高の 2 倍未満にし、枠線を帯の下端付近だけに置く。上へ h だけ
    // 遡ると帯の外へ出るので、クランプして帯内に押し込むのではなく null を返すのが正しい。
    const data = blank();
    fillRect(data, { x: 150, y: 128, w: 100, h: 4 }, [240, 240, 240]);
    const narrow: Rect = { x: 120, y: 110, w: 160, h: 26 };
    expect(locateMarkPlate({ w: W, h: H, data }, narrow, OPTS)).toBeNull();
  });

  it('枠線候補が 3 本あっても、間隔がプレート比に合うペアを選ぶ', () => {
    // 実測の失敗モード: 素朴に「最上と最下」を採ると、プレートの下にあるアバターの明るい
    // 髪の塊を下枠と誤認して高さが 1.7 倍に伸びた（TL のレイズ）。
    const img = renderPlate(WORD_RAISE, ACTIVE);
    fillRect(img.data as Uint8Array, { x: 152, y: 150, w: 96, h: 4 }, [240, 240, 240]);
    const plate = locateMarkPlate(img, { x: 120, y: 55, w: 160, h: 110 }, OPTS)!;
    expect(plate.rect.y).toBeCloseTo(PLATE.y, -1);
    expect(plate.rect.h).toBe(Math.round(0.36 * plate.rect.w));
  });

  it('プレート幅と合わない長い横線（バナー等）は枠線とみなさない', () => {
    const data = blank();
    // 帯を横断する幅 150px の明るい帯（プレート幅 100 の 1.5 倍 = 窓の上限 1.40 超）。
    fillRect(data, { x: 125, y: 70, w: 150, h: 4 }, [240, 240, 240]);
    fillRect(data, { x: 125, y: 120, w: 150, h: 4 }, [240, 240, 240]);
    expect(locateMarkPlate({ w: W, h: H, data }, ZONE, OPTS)).toBeNull();
  });
});

describe('markInkMask / normMark', () => {
  it('Otsu なのでフォールドと能動でインク率が近い', () => {
    const inkFrac = (style: PlateStyle): number => {
      const img = renderPlate(WORD_FOLD, style);
      const m = markInkMask(img, locateMarkPlate(img, ZONE, OPTS)!.rect);
      return m.data.reduce((n, v) => n + (v > 0 ? 1 : 0), 0) / m.data.length;
    };
    const f = inkFrac(FOLD), a = inkFrac(ACTIVE);
    expect(Math.abs(f - a)).toBeLessThan(0.05);
  });

  it('正規化像の高さは MARK_NORM_H', () => {
    const img = renderPlate(WORD_RAISE, ACTIVE);
    const n = normMark(markInkMask(img, locateMarkPlate(img, ZONE, OPTS)!.rect));
    expect(n.h).toBe(MARK_NORM_H);
  });
});

describe('recognizeMark', () => {
  it('フォールドのプレートを fold にする', () => {
    const r = recognizeMark(renderPlate(WORD_FOLD, FOLD), ZONE, templates, OPTS);
    expect(r.value).toBe('fold');
  });

  it('能動のプレートを対応する action にする', () => {
    const r = recognizeMark(renderPlate(WORD_RAISE, ACTIVE), ZONE, templates, OPTS);
    expect(r.value).toBe('raise');
  });

  it('プレートが無ければ none（高信頼）', () => {
    const r = recognizeMark({ w: W, h: H, data: blank() }, ZONE, templates, OPTS);
    expect(r.value).toBe('none');
    expect(r.conf).toBeGreaterThan(0.8);
  });

  it('語が能動なのにプレートが沈んでいたら none（彩度ゲート）', () => {
    // 能動の語形を fold の配色で描く → NCC は レイズ に寄るが彩度が合わない。
    const { read, diag } = recognizeMarkDiag(renderPlate(WORD_RAISE, FOLD), ZONE, templates, OPTS);
    expect(read.value).toBe('none');
    expect(diag.rejected).toBe('sat');
  });

  it('知らない語形（テンプレに無い）は NCC 信頼度ゲートで none', () => {
    const { read, diag } = recognizeMarkDiag(
      renderPlate([1, 1, 1, 1, 1, 1, 1], ACTIVE), // 全帯＝どちらの語にも似ない
      ZONE,
      templates,
      { ...OPTS, confFloor: 0.99 },
    );
    expect(read.value).toBe('none');
    expect(diag.rejected).toBe('conf');
  });

  it('インク率がプレートらしくなければ none（インク率ゲート）', () => {
    const { read, diag } = recognizeMarkDiag(renderPlate(WORD_RAISE, ACTIVE), ZONE, templates, {
      ...OPTS,
      inkMin: 0.9, // 現実にはあり得ない下限。ゲートが実際に効いているかだけを見る
    });
    expect(read.value).toBe('none');
    expect(diag.rejected).toBe('ink');
  });

  it('彩度が死角（fold 帯と能動帯の間）なら none', () => {
    // hero 席の常設装飾がこの帯に出て、しきい値方式では偽陽性になっていた（実測 30 件）。
    const img = renderPlate(WORD_RAISE, DEADZONE);
    const sat = meanSaturation(img, locateMarkPlate(img, ZONE, OPTS)!.rect);
    expect(sat).toBeGreaterThan(49);
    expect(sat).toBeLessThan(68);
    expect(recognizeMark(img, ZONE, templates, OPTS).value).toBe('none');
  });
});

describe('MARK_WORDS', () => {
  it('フォールドを含む 5 語を持つ（従来の actionTag は 4 語）', () => {
    expect(Object.keys(MARK_WORDS)).toHaveLength(5);
    expect(MARK_WORDS['フォールド']).toBe('fold');
  });
});
