/**
 * Training ▸ Stats（Slumbot HU の成績, SPEC §7.4.6）。
 * 上段に集計、下段に累積収支のグラフ（収支 / 収支EV / SD / NSD）と期間の切り替え。
 */

import { useMemo, useState } from 'react';

import { HuChart, SERIES_META, type SeriesKey } from './HuChart';
import { signedBbLabel } from '../slumbot/rules';
import { PERIODS, cumulativeSeries, filterByPeriod, kLabel, pctLabel, summarize, type Period } from '../slumbot/stats';
import { useHuHands } from '../slumbot/useHuHands';

function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function rate(v: number): string {
  const s = (Math.round(v * 100) / 100).toFixed(2);
  return v > 0 ? `+${s}` : v < 0 ? `−${s.slice(1)}` : s;
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

const toneOf = (v: number): 'neg' | 'pos' | null => (v < 0 ? 'neg' : v > 0 ? 'pos' : null);

export function HuStatsView(): JSX.Element {
  const { hands, note } = useHuHands();
  const [period, setPeriod] = useState<Period>('all');
  const [visible, setVisible] = useState<Record<SeriesKey, boolean>>({ net: true, ev: true, sd: true, nsd: true });

  const all = hands ?? [];
  const picked = useMemo(() => filterByPeriod(all, period), [all, period]);
  const sum = useMemo(() => summarize(picked), [picked]);
  const series = useMemo(() => cumulativeSeries(picked), [picked]);
  const first = all[0]?.playedAt ?? null;

  if (hands === null) {
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
          <span className="hs-title">Slumbot HU</span>
          <span className="hs-total">
            総ハンド数 <b>{all.length.toLocaleString()}</b>
          </span>
        </div>
        <div className="hs-first">
          <span>First Play</span>
          <b>{first === null ? '–' : fmtDate(first)}</b>
        </div>

        <div className="hs-grid">
          <Stat label="ハンド数" value={sum.hands.toLocaleString()} />
          <Stat label="実収支" value={signedBbLabel(sum.net, 2)} unit="bb" tone={toneOf(sum.net)} />
          <Stat label="Win Rate" value={rate(sum.winRate)} unit="bb/100" tone={toneOf(sum.winRate)} />
          <Stat
            label="SD / NSD"
            value={`${signedBbLabel(sum.sd, 1)} / ${signedBbLabel(sum.nsd, 1)}`}
            unit="bb"
          />
          <Stat label="収支 (EV)" value={signedBbLabel(sum.ev, 2)} unit="bb" tone={toneOf(sum.ev)} />
          <Stat label="Win Rate (EV)" value={rate(sum.evWinRate)} unit="bb/100" tone={toneOf(sum.evWinRate)} />
          <Stat label="VPIP" value={pctLabel(sum.vpip)} sub={`(${kLabel(sum.vpip.n)}/${kLabel(sum.vpip.d)})`} />
          <Stat label="PFR" value={pctLabel(sum.pfr)} sub={`(${kLabel(sum.pfr.n)}/${kLabel(sum.pfr.d)})`} />
          <Stat label="3Bet" value={pctLabel(sum.threeBet)} sub={`(${kLabel(sum.threeBet.n)}/${kLabel(sum.threeBet.d)})`} />
        </div>
      </div>

      <div className="panel hs-panel">
        <HuChart series={series} visible={visible} />

        <div className="hs-legend" role="group" aria-label="表示する系列">
          {SERIES_META.map((m) => (
            <button
              key={m.key}
              type="button"
              className={`hs-lg s-${m.key}${visible[m.key] ? ' on' : ''}`}
              aria-pressed={visible[m.key]}
              onClick={() => setVisible((v) => ({ ...v, [m.key]: !v[m.key] }))}
            >
              <i />
              {m.label}
            </button>
          ))}
        </div>

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

        {all.length === 0 && (
          <p className="hs-empty">まだ履歴がありません。Slumbot HU を打つと、ここに貯まります。</p>
        )}
      </div>
    </div>
  );
}
