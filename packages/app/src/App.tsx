import { useState } from 'react';
import { SAMPLE_SPOTS } from './sampleSpots';
import { solveInWorker, type SolveOutcome } from './solverClient';

/**
 * Phase 3-1a の動作確認 UI。サンプル盤面を選んで「ブラウザ内で求解」を押すと、
 * Web Worker でソルバーが走り、hero のオープン PU ノード・EV・EQ・収束品質・所要時間を表示する。
 * これは in-browser 求解（最難関の技術リスク）を実証するための最小画面。
 * 手入力フォーム（3-1b）・本格結果画面（3-1c/3-2）は後続。
 */
export function App(): JSX.Element {
  const [spotIdx, setSpotIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<SolveOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);

  const spot = SAMPLE_SPOTS[spotIdx]!;

  async function run(): Promise<void> {
    setBusy(true);
    setError(null);
    setOutcome(null);
    try {
      const res = await solveInWorker(spot.state, spot.opts);
      setOutcome(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const heroPos = spot.state.heroPos;
  const openNode = outcome?.result.nodes.find(
    (n) => n.actor === heroPos && n.actionType === 'PU' && !n.key.includes(':P') && !n.key.includes(':C'),
  );

  return (
    <div className="app">
      <header className="hdr">
        <h1>押し引きノート</h1>
        <span className="tag">Phase 3-1a · in-browser solve</span>
      </header>

      <section className="panel">
        <label className="lbl">サンプル盤面</label>
        <select
          className="sel"
          value={spotIdx}
          onChange={(e) => {
            setSpotIdx(Number(e.target.value));
            setOutcome(null);
            setError(null);
          }}
          disabled={busy}
        >
          {SAMPLE_SPOTS.map((s, i) => (
            <option key={s.label} value={i}>
              {s.label}
            </option>
          ))}
        </select>
        <button className="btn" onClick={run} disabled={busy}>
          {busy ? '求解中…（Web Worker）' : 'ブラウザ内で求解'}
        </button>
        <p className="hero">
          hero: <b>{heroPos}</b> / {spot.state.heroHand} / {spot.state.playersLeft} left
        </p>
      </section>

      {error && <section className="panel err">エラー: {error}</section>}

      {outcome && (
        <section className="panel result">
          <div className="row">
            <span>所要時間</span>
            <b>{(outcome.ms / 1000).toFixed(2)} s</b>
          </div>
          <div className="row">
            <span>iterations</span>
            <b>{outcome.result.iterations}</b>
          </div>
          <div className="row">
            <span>exploitability</span>
            <b>{outcome.result.exploitabilityPt.toFixed(4)} pt</b>
          </div>
          <div className="row">
            <span>converged</span>
            <b className={outcome.result.converged ? 'ok' : 'warn'}>
              {String(outcome.result.converged)}
            </b>
          </div>

          {openNode ? (
            <div className="node">
              <div className="node-h">
                {openNode.actor} 先手 PU（未開）
              </div>
              <div className="row">
                <span>push %</span>
                <b>{openNode.pct.toFixed(1)}%</b>
              </div>
              <div className="range">{openNode.range || '(空)'}</div>
            </div>
          ) : (
            <div className="node">hero のオープン PU ノードが見つかりません</div>
          )}

          <div className="eq">
            <div className="eq-h">ICM equity（実払い pt）</div>
            <table>
              <thead>
                <tr>
                  <th>pos</th>
                  <th>EQPre</th>
                  <th>EQPost</th>
                  <th>EQDiff</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(outcome.result.equity).map(([pos, e]) => (
                  <tr key={pos}>
                    <td>{pos}</td>
                    <td>{e.pre.toFixed(3)}</td>
                    <td>{e.post.toFixed(3)}</td>
                    <td>{(e.post - e.pre).toFixed(3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <footer className="ft">
        端末ローカル完結・RTA なし。数値は実払い pt。求解は端末内（Web Worker）。
      </footer>
    </div>
  );
}
