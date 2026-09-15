/**
 * Training ▸ Stats ▸ SIT & GO タブ（docs/SNG_DESIGN.md §5）。
 * 上段に集計、順位分布、累計 pt のグラフと期間の切り替え。`HuStatsView` と同じ骨組み。
 */

import { useMemo, useState, type PointerEvent } from 'react';

import { niceTicks } from './HuChart';
import { pctLabel } from '../slumbot/stats';
import { PERIODS, cumulativePt, filterByPeriod, recentPlaces, summarizeSng, type Period, type PtPoint } from '../sng/stats';
import { useSngHands } from '../sng/useSngHands';

function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function fmtPt(v: number): string {
  if (v === 0) return '±0';
  const s = (Math.round(Math.abs(v) * 10) / 10).toFixed(1).replace(/\.0$/, '');
  return `${v > 0 ? '+' : '−'}${s}`;
}

function toneOf(v: number): 'neg' | 'pos' | null {
  return v < 0 ? 'neg' : v > 0 ? 'pos' : null;
}

function Stat(props: { label: string; value: string; unit?: string; sub?: string; tone?: 'neg' | 'pos' | null }): JSX.Element {
  return (
    <div className="hs-stat">
      <span className="statlbl">{props.label}</span>
      <b className={`hs-val${props.tone === 'neg' ? ' loss' : props.tone === 'pos' ? ' gain' : ''}`}>
        {props.value}
        {props.unit && <span className="hs-unit">{props.unit}</span>}
      </b>
      {props.sub && <span className="hs-sub">{props.sub}</span>}
    </div>
  );
}

const PLACE_LABEL = ['1位', '2位', '3位', '4位', '5位', '6位'];

function PlaceDist(props: { dist: readonly number[]; maxPlayers: number }): JSX.Element {
  const n = Math.min(6, Math.max(2, props.maxPlayers || 6));
  const rows = props.dist.slice(0, n);
  const max = Math.max(1, ...rows);
  return (
    <div className="spd">
      {rows.map((count, i) => (
        <div key={i} className="spd-row">
          <span className="spd-label">{PLACE_LABEL[i] ?? `${i + 1}位`}</span>
          <span className="spd-bar">
            <span className={`spd-fill${i === 0 ? ' first' : ''}`} style={{ width: `${(count / max) * 100}%` }} />
          </span>
          <span className="spd-count">{count}</span>
        </div>
      ))}
    </div>
  );
}

const CW = 360;
const CH = 180;
const CPL = 40;
const CPR = 10;
const CPT = 10;
const CPB = 22;
const CPW = CW - CPL - CPR;
const CPH = CH - CPT - CPB;

function PtChart(props: { points: readonly PtPoint[] }): JSX.Element {
  const { points } = props;
  const n = points.length;
  const [hover, setHover] = useState<number | null>(null);

  const geo = useMemo(() => {
    let min = 0;
    let max = 0;
    for (const p of points) {
      if (p.y < min) min = p.y;
      if (p.y > max) max = p.y;
    }
    if (max - min < 2) {
      max += 1;
      min -= 1;
    }
    const ticks = niceTicks(min, max);
    const lo = Math.min(min, ticks[0] ?? min);
    const hi = Math.max(max, ticks[ticks.length - 1] ?? max);
    const x = (i: number): number => CPL + (n <= 1 ? CPW / 2 : (i / (n - 1)) * CPW);
    const y = (v: number): number => CPT + ((hi - v) / (hi - lo || 1)) * CPH;
    const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(p.y).toFixed(1)}`).join(' ');
    const xTicks: number[] = [];
    if (n > 0) {
      const count = Math.min(5, n);
      for (let k = 0; k < count; k += 1) xTicks.push(Math.round((k * (n - 1)) / Math.max(1, count - 1)));
    }
    return { ticks, x, y, path, xTicks };
  }, [points, n]);

  function onMove(e: PointerEvent<SVGSVGElement>): void {
    if (n === 0) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const xr = ((e.clientX - rect.left) / rect.width) * CW;
    const t = n <= 1 ? 0 : ((xr - CPL) / CPW) * (n - 1);
    setHover(Math.max(0, Math.min(n - 1, Math.round(t))));
  }

  const zeroY = geo.y(0);

  return (
    <div className="hc spt-chart">
      <div className="hc-read" aria-live="polite">
        {hover === null ? (
          <span className="hc-read-hint">{n > 0 ? 'なぞると各試合時点の値' : ''}</span>
        ) : (
          <span className="hc-read-v spt-v">
            <i />#{hover + 1} {fmtPt(points[hover]?.y ?? 0)}pt
          </span>
        )}
      </div>
      <svg
        className="hc-svg"
        viewBox={`0 0 ${CW} ${CH}`}
        role="img"
        aria-label="累計 pt のグラフ"
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {geo.ticks.map((t) => (
          <g key={t}>
            <line className={`hc-grid${t === 0 ? ' zero' : ''}`} x1={CPL} x2={CW - CPR} y1={geo.y(t)} y2={geo.y(t)} />
            <text className="hc-ylbl" x={CPL - 5} y={geo.y(t) + 3}>
              {t}
            </text>
          </g>
        ))}
        {n > 0 && geo.ticks.every((t) => t !== 0) && <line className="hc-grid zero" x1={CPL} x2={CW - CPR} y1={zeroY} y2={zeroY} />}
        {geo.xTicks.map((i, k) => (
          <text
            key={`${i}-${k}`}
            className="hc-xlbl"
            x={geo.x(i)}
            y={CH - 6}
            textAnchor={k === 0 ? 'start' : k === geo.xTicks.length - 1 ? 'end' : 'middle'}
          >
            {i + 1}
          </text>
        ))}
        {n > 0 && <path className="hc-line spt-line" d={geo.path} />}
        {n === 1 && <circle className="hc-dot spt-dot" cx={geo.x(0)} cy={geo.y(points[0]?.y ?? 0)} r={3} />}
        {hover !== null && (
          <g>
            <line className="hc-cursor" x1={geo.x(hover)} x2={geo.x(hover)} y1={CPT} y2={CH - CPB} />
            <circle className="hc-dot spt-dot" cx={geo.x(hover)} cy={geo.y(points[hover]?.y ?? 0)} r={3.5} />
          </g>
        )}
        {n === 0 && (
          <text className="hc-empty" x={CW / 2} y={CH / 2} textAnchor="middle">
            NO DATA
          </text>
        )}
      </svg>
    </div>
  );
}

export function SngStatsView(props: { onOpenHistory: () => void }): JSX.Element {
  const { results, note } = useSngHands();
  const [period, setPeriod] = useState<Period>('all');

  const all = results ?? [];
  const picked = useMemo(() => filterByPeriod(all, period), [all, period]);
  const sum = useMemo(() => summarizeSng(picked), [picked]);
  const points = useMemo(() => cumulativePt(picked), [picked]);
  const recent = useMemo(() => recentPlaces(all, 10), [all]);
  const first = all[0]?.endedAt ?? null;

  if (results === null) {
    return (
      <div className="hs-wrap">
        <div className="panel solving">
          <div className="spinner" />
          <p>読み込み中…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="hs-wrap">
      {note && <p className="hs-note">{note}</p>}

      <div className="panel hs-panel">
        <div className="hs-head">
          <span className="hs-title">SIT &amp; GO</span>
          <span className="hs-total">
            試合数 <b>{all.length.toLocaleString()}</b>
          </span>
        </div>
        <button type="button" className="btn ghost wide hs-history-btn" onClick={props.onOpenHistory}>
          HAND HISTORY
        </button>
        <div className="hs-first">
          <span>First Play</span>
          <b>{first === null ? '–' : fmtDate(first)}</b>
        </div>

        <div className="hs-grid">
          <Stat label="試合数" value={sum.games.toLocaleString()} />
          <Stat label="平均順位" value={sum.games > 0 ? sum.avgPlace.toFixed(2) : '–'} unit="位" />
          <Stat label="1位率" value={pctLabel(sum.firstRate)} unit="%" />
          <Stat label="入賞率" value={pctLabel(sum.cashRate)} unit="%" sub="(pt > 0)" />
          <Stat label="累計pt" value={fmtPt(sum.totalPt)} unit="pt" tone={toneOf(sum.totalPt)} />
          <Stat label="直近の成績" value={recent.length > 0 ? recent.join(' ') : '–'} sub={recent.length > 0 ? '古い→新しい' : undefined} />
        </div>
      </div>

      <div className="panel hs-panel">
        <span className="hs-title spd-title">順位分布</span>
        <PlaceDist dist={sum.placeDist} maxPlayers={sum.maxPlayers} />
      </div>

      <div className="panel hs-panel">
        <PtChart points={points} />

        <div className="hs-period">
          <span className="hs-period-lbl">期間</span>
          <div className="hs-seg">
            {PERIODS.map((p) => (
              <button
                key={p.key}
                type="button"
                className={`segbtn${period === p.key ? ' on' : ''}`}
                onClick={() => setPeriod(p.key)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {all.length === 0 && <p className="hs-empty">まだ試合がありません。SIT &amp; GO を打つと、ここに貯まります。</p>}
      </div>
    </div>
  );
}
