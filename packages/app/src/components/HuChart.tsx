/**
 * Slumbot HU の累積収支グラフ（SPEC §7.4.6）。SVG を自前で描く（依存ゼロ）。
 *
 * 4 本の折れ線: 収支（緑）/ 収支EV（黄）/ SD（シアン）/ NSD（赤）。色は席や順位でなく
 * 「系列そのもの」に固定する（凡例で消しても残りの色は変えない）。
 * 指でなぞると縦線と、その時点の各系列の値を上の行に出す。
 */

import { useMemo, useState, type PointerEvent } from 'react';

import { signedBbLabel } from '../slumbot/rules';
import type { Series } from '../slumbot/stats';

export type SeriesKey = keyof Series;

export const SERIES_META: readonly { key: SeriesKey; label: string }[] = [
  { key: 'net', label: '収支' },
  { key: 'ev', label: '収支EV' },
  { key: 'sd', label: 'SD' },
  { key: 'nsd', label: 'NSD' },
];

const W = 360;
const H = 220;
const PL = 40;
const PR = 10;
const PT = 10;
const PB = 22;
const PW = W - PL - PR;
const PH = H - PT - PB;

/** 見やすい刻みの目盛（min〜max を 4〜6 分割）。 */
export function niceTicks(min: number, max: number): number[] {
  const span = max - min || 1;
  const rough = span / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / pow;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * pow;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

function fmtTick(v: number): string {
  const a = Math.abs(v);
  if (a >= 1000) return `${v / 1000}k`;
  return String(v);
}

export function HuChart(props: {
  series: Series;
  visible: Record<SeriesKey, boolean>;
}): JSX.Element {
  const { series, visible } = props;
  const n = series.net.length;
  const [hover, setHover] = useState<number | null>(null);

  const geo = useMemo(() => {
    let min = 0;
    let max = 0;
    for (const m of SERIES_META) {
      if (!visible[m.key]) continue;
      for (const v of series[m.key]) {
        const bb = v / 100;
        if (bb < min) min = bb;
        if (bb > max) max = bb;
      }
    }
    if (max - min < 2) {
      max += 1;
      min -= 1;
    }
    const ticks = niceTicks(min, max);
    const lo = Math.min(min, ticks[0] ?? min);
    const hi = Math.max(max, ticks[ticks.length - 1] ?? max);
    const x = (i: number): number => PL + (n <= 1 ? PW / 2 : (i / (n - 1)) * PW);
    const y = (chips: number): number => PT + ((hi - chips / 100) / (hi - lo)) * PH;
    const path = (arr: readonly number[]): string =>
      arr.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
    const xTicks: number[] = [];
    if (n > 0) {
      const count = Math.min(5, n);
      for (let k = 0; k < count; k += 1) xTicks.push(Math.round((k * (n - 1)) / Math.max(1, count - 1)));
    }
    return { lo, hi, ticks, x, y, path, xTicks };
  }, [series, visible, n]);

  function onMove(e: PointerEvent<SVGSVGElement>): void {
    if (n === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const xr = ((e.clientX - rect.left) / rect.width) * W;
    const t = n <= 1 ? 0 : ((xr - PL) / PW) * (n - 1);
    setHover(Math.max(0, Math.min(n - 1, Math.round(t))));
  }

  const zeroY = geo.y(0);

  return (
    <div className="hc">
      <div className="hc-read" aria-live="polite">
        {hover === null ? (
          <span className="hc-read-hint">{n > 0 ? 'なぞると各ハンド時点の値' : ''}</span>
        ) : (
          <>
            <span className="hc-read-n">#{hover + 1}</span>
            {SERIES_META.filter((m) => visible[m.key]).map((m) => (
              <span key={m.key} className={`hc-read-v s-${m.key}`}>
                <i />
                {signedBbLabel(series[m.key][hover] ?? 0)}
              </span>
            ))}
          </>
        )}
      </div>
      <svg
        className="hc-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="累積収支のグラフ"
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {geo.ticks.map((t) => (
          <g key={t}>
            <line
              className={`hc-grid${t === 0 ? ' zero' : ''}`}
              x1={PL}
              x2={W - PR}
              y1={geo.y(t * 100)}
              y2={geo.y(t * 100)}
            />
            <text className="hc-ylbl" x={PL - 5} y={geo.y(t * 100) + 3}>
              {fmtTick(t)}
            </text>
          </g>
        ))}
        {n > 0 && geo.ticks.every((t) => t !== 0) && (
          <line className="hc-grid zero" x1={PL} x2={W - PR} y1={zeroY} y2={zeroY} />
        )}
        {geo.xTicks.map((i, k) => (
          <text
            key={`${i}-${k}`}
            className="hc-xlbl"
            x={geo.x(i)}
            y={H - 6}
            textAnchor={k === 0 ? 'start' : k === geo.xTicks.length - 1 ? 'end' : 'middle'}
          >
            {i + 1}
          </text>
        ))}
        {/* 重なったときに主役（収支）が上に来るよう、描画は凡例の逆順（NSD → SD → 収支EV → 収支）。 */}
        {n > 0 &&
          [...SERIES_META]
            .reverse()
            .filter((m) => visible[m.key])
            .map((m) => <path key={m.key} className={`hc-line s-${m.key}`} d={geo.path(series[m.key])} />)}
        {n === 1 &&
          SERIES_META.filter((m) => visible[m.key]).map((m) => (
            <circle key={m.key} className={`hc-dot s-${m.key}`} cx={geo.x(0)} cy={geo.y(series[m.key][0] ?? 0)} r={3} />
          ))}
        {hover !== null && (
          <g>
            <line className="hc-cursor" x1={geo.x(hover)} x2={geo.x(hover)} y1={PT} y2={H - PB} />
            {SERIES_META.filter((m) => visible[m.key]).map((m) => (
              <circle
                key={m.key}
                className={`hc-dot s-${m.key}`}
                cx={geo.x(hover)}
                cy={geo.y(series[m.key][hover] ?? 0)}
                r={3.5}
              />
            ))}
          </g>
        )}
        {n === 0 && (
          <text className="hc-empty" x={W / 2} y={H / 2} textAnchor="middle">
            NO DATA
          </text>
        )}
      </svg>
    </div>
  );
}
