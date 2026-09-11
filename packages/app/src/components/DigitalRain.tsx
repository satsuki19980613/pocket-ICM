import { useEffect, useRef } from 'react';

/**
 * 背景の 0/1 デジタルレイン（サイバーパンク HUD の“端末が流れている”感じ）。
 * グラファイトの下地（`.bgfield` = z-index:-2）の上に重ねる薄い前景で、こちらが -1。
 *
 * 実装メモ:
 * - 尾は「毎フレーム薄い黒で塗る」古典手法ではなく **destination-out で少しずつ消す**。
 *   塗り足すとキャンバスが不透明になっていき、背後の下地が見えなくなるため。
 * - 30fps に落として描く（雨は 60fps である必要が無く、負荷が半分になる）。
 * - devicePixelRatio は 1.5 で頭打ち。全画面を毎フレーム触るので、3倍解像度は割に合わない。
 * - 非表示タブでは止める（電池）。`prefers-reduced-motion` では一切描かない。
 * - 文字色はブランドのシアンを主、たまに黄（配色比 §11 を崩さないため。緑は使わない）。
 */

/** 列の間隔・行の高さ（CSS px）。 */
const COL_W = 18;
const ROW_H = 18;
const FONT_PX = 14;
/** 1 フレームで消える量。大きいほど尾が短い。 */
const FADE = 0.055;
const FPS = 30;
const MAX_DPR = 1.5;

export interface RainColumn {
  /** 先頭の行位置（行単位・小数可）。 */
  readonly y: number;
  /** 1 フレームあたりの行数。1 を超えると尾が飛び飛びになるので上限 1。 */
  readonly speed: number;
  /** 0..1。高いほど「黄色く光る列」になる（たまに混ぜてブランド色を効かせる）。 */
  readonly hot: number;
}

/** 画面幅に対する列数。 */
export function columnCount(width: number, colWidth = COL_W): number {
  return Math.max(1, Math.ceil(width / colWidth));
}

/** 新しい列（画面上端より上のばらけた位置から降り始める）。 */
export function makeColumn(rand: () => number): RainColumn {
  return { y: -rand() * 40, speed: 0.25 + rand() * 0.75, hot: rand() };
}

/** 列を 1 フレーム進める。下に抜けたら上へ戻し、速度と“熱さ”を引き直す。 */
export function stepColumn(col: RainColumn, rowsOnScreen: number, rand: () => number): RainColumn {
  const y = col.y + col.speed;
  if (y > rowsOnScreen + 6) return makeColumn(rand);
  return { y, speed: col.speed, hot: col.hot };
}

export function DigitalRain(): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const mono =
      getComputedStyle(document.documentElement).getPropertyValue('--mono').trim() ||
      'ui-monospace, monospace';

    let cols: RainColumn[] = [];
    let w = 0;
    let h = 0;
    let dpr = 1;

    const resize = (): void => {
      const nextDpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      // 高さが縮むだけ（スレッド画面でキーボードが出てレイアウトが縮んだとき）は描き直さない。
      // 作り直すと雨が上から降り直して一瞬消える。はみ出た分はキーボードの裏に隠れるだけ。
      if (h > 0 && w === window.innerWidth && nextDpr === dpr && window.innerHeight <= h) return;
      dpr = nextDpr;
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.font = `${FONT_PX}px ${mono}`;
      ctx.textBaseline = 'top';
      cols = Array.from({ length: columnCount(w) }, () => makeColumn(Math.random));
    };
    resize();

    let raf = 0;
    let last = 0;
    const interval = 1000 / FPS;

    const draw = (t: number): void => {
      raf = requestAnimationFrame(draw);
      if (document.hidden) return;
      if (t - last < interval) return;
      last = t;

      // 既に描いた文字を少しずつ「消す」。塗り足さないので背後のマーブルは透ける。
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = `rgba(0, 0, 0, ${FADE})`;
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'source-over';

      const rows = Math.ceil(h / ROW_H);
      for (let i = 0; i < cols.length; i++) {
        const col = cols[i]!;
        const row = Math.floor(col.y);
        const y = row * ROW_H;
        if (y >= -ROW_H && y <= h) {
          ctx.fillStyle = col.hot > 0.92 ? 'rgba(252, 238, 10, 0.46)' : 'rgba(58, 230, 255, 0.30)';
          ctx.fillText(Math.random() < 0.5 ? '0' : '1', i * COL_W + 3, y);
        }
        cols[i] = stepColumn(col, rows, Math.random);
      }
    };
    raf = requestAnimationFrame(draw);
    window.addEventListener('resize', resize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return <canvas ref={ref} className="rain" aria-hidden="true" />;
}
