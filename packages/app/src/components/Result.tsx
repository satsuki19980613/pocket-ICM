import { useState } from 'react';
import type { BoardState } from '@oshihiki/core';
import type { SolveNodeDto, SolveResultDto } from '../solverProtocol';
import { RangeGrid } from './RangeGrid';

const ACTION_JA: Record<string, string> = { PU: '先手プッシュ (PU)', CA: 'コール (CA)', OC: 'オーバーコール (OC)' };

/** EV の大きさバンド（SPEC §4）。|EV|<0.05 小 / 0.05–0.2 / >0.2 大。 */
function evBand(ev: number): 'minor' | 'mid' | 'major' {
  const a = Math.abs(ev);
  return a < 0.05 ? 'minor' : a <= 0.2 ? 'mid' : 'major';
}

function isUnopened(n: SolveNodeDto): boolean {
  return n.actionType === 'PU' && !n.key.includes(':P') && !n.key.includes(':C');
}

/** 基本の結果画面（3-1c）。判定・EV・レンジ表・EQ・収束品質・全ノード。 */
export function Result(props: { state: BoardState; result: SolveResultDto; onBack: () => void; ms: number }): JSX.Element {
  const { result, state } = props;
  const [showAll, setShowAll] = useState(false);
  const heroNodes = result.nodes.filter((n) => n.actor === result.heroPos);
  const headline = heroNodes.find(isUnopened) ?? heroNodes[0];
  const heroSeat = state.seats.find((s) => s.pos === result.heroPos);

  const verdict = (n: SolveNodeDto): 'PUSH' | 'FOLD' => (n.heroFreq >= 0.5 ? 'PUSH' : 'FOLD');

  return (
    <div className="result-wrap">
      {headline ? (
        <div className="panel vhero">
          <div className={`verdict ${verdict(headline) === 'PUSH' ? 'push' : 'fold'}`}>{verdict(headline)}</div>
          <div className="vmeta">
            <b className="vhand">{result.heroHand}</b>
            <span>
              {result.heroPos}・{heroSeat ? `${heroSeat.stack}bb` : ''}・{result.playersLeft} left
            </span>
            <span className="vaction">{ACTION_JA[headline.actionType] ?? headline.actionType}</span>
          </div>
          <div className="evbox">
            <span className="evlabel">EV（フォールド比, 実払い pt）</span>
            <b className={`evval ${evBand(headline.heroEv)}`}>
              {headline.heroEv >= 0 ? '+' : ''}
              {headline.heroEv.toFixed(3)}
            </b>
          </div>
          <div className="freqbar">
            <div className="freqfill" style={{ width: `${Math.min(100, headline.pct)}%` }} />
            <span className="freqtxt">レンジ {headline.pct.toFixed(1)}%</span>
          </div>
          <RangeGrid hands={headline.hands} heroHand={result.heroHand} />
          <div className="rangestr">{headline.range || '(空)'}</div>
        </div>
      ) : (
        <div className="panel">hero の決定ノードがありません（BB のウォーク等）。下の一覧を参照。</div>
      )}

      {heroNodes.length > 1 && (
        <div className="panel">
          <div className="scr-h sm">hero の他の状況</div>
          {heroNodes.filter((n) => n !== headline).map((n) => (
            <div key={n.key} className="hnode">
              <span className="ht">{ACTION_JA[n.actionType]?.split(' ')[0] ?? n.actionType}</span>
              <span className={`hv ${verdict(n) === 'PUSH' ? 'push' : 'fold'}`}>{verdict(n)}</span>
              <span className="hpct">{n.pct.toFixed(1)}%</span>
              <span className={`hev ${evBand(n.heroEv)}`}>
                {n.heroEv >= 0 ? '+' : ''}
                {n.heroEv.toFixed(3)}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="panel">
        <div className="scr-h sm">ICM equity（実払い pt）</div>
        <table className="eqt">
          <thead>
            <tr><th>pos</th><th>EQPre</th><th>EQPost</th><th>EQDiff</th></tr>
          </thead>
          <tbody>
            {Object.entries(result.equity).map(([pos, e]) => (
              <tr key={pos} className={pos === result.heroPos ? 'herorow' : ''}>
                <td>{pos}</td>
                <td>{e.pre.toFixed(3)}</td>
                <td>{e.post.toFixed(3)}</td>
                <td>{(e.post - e.pre).toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel quality">
        <div className="row"><span>求解時間</span><b>{(props.ms / 1000).toFixed(2)} s</b></div>
        <div className="row"><span>iterations</span><b>{result.iterations}</b></div>
        <div className="row"><span>exploitability</span><b>{result.exploitabilityPt.toFixed(4)} pt</b></div>
        {!result.converged && (
          <p className="convnote">
            ⚠ 収束不十分（exploitability がしきい値超）。境界ハンドの押し引きは目安として扱ってください。
          </p>
        )}
      </div>

      <div className="panel">
        <button type="button" className="disc" onClick={() => setShowAll((s) => !s)}>
          全ノード（{result.nodes.length}） {showAll ? '▲' : '▼'}
        </button>
        {showAll && (
          <div className="allnodes">
            {result.nodes.map((n) => (
              <div key={n.key} className="anode">
                <span className="ak">{n.key}</span>
                <span className="aa">{n.actor}/{n.actionType}</span>
                <span className="ap">{n.pct.toFixed(1)}%</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <button type="button" className="btn ghost wide" onClick={props.onBack}>
        別のスポットを入力
      </button>
    </div>
  );
}
