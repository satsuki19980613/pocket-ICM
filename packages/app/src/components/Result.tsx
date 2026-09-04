import { useState } from 'react';
import type { BoardState } from '@oshihiki/core';
import type { SolveNodeDto, SolveResultDto } from '../solverProtocol';
import { RangeGrid } from './RangeGrid';
import { evLossOf, headlineNode, verdictOf, type HeroAction } from '../records/model';

const ACTION_JA: Record<string, string> = { PU: '先手プッシュ (PU)', CA: 'コール (CA)', OC: 'オーバーコール (OC)' };

/**
 * EV の符号で色分け（CP2077 配色: 黄=+EV / 赤=−EV）。判定と一致し、モックの
 * evbox（push→黄 / fold→赤）に沿う。赤は「損失」だけに使う原則を保つ。
 */
function evClass(ev: number): 'pos' | 'neg' {
  return ev >= 0 ? 'pos' : 'neg';
}

/** 基本の結果画面（3-1c）＋記録（3-2）。判定・EV・レンジ表・EQ・収束品質・全ノード。 */
export function Result(props: {
  state: BoardState;
  result: SolveResultDto;
  onBack: () => void;
  ms: number;
  /** 記録の保存ハンドラ（読み取り専用の再表示時は未指定）。 */
  onSave?: (heroAction: HeroAction) => void;
  /** 履歴からの再表示（保存 UI を出さず、記録済みの情報を表示）。 */
  readOnly?: boolean;
  /** readOnly 時に表示する、記録済みの実行動と EV loss。 */
  savedAction?: HeroAction;
  savedEvLoss?: number;
}): JSX.Element {
  const { result, state } = props;
  const [showAll, setShowAll] = useState(false);
  const [action, setAction] = useState<HeroAction | null>(null);
  const [saved, setSaved] = useState(false);
  const heroNodes = result.nodes.filter((n) => n.actor === result.heroPos);
  const headline = headlineNode(result) ?? heroNodes[0];
  const heroSeat = state.seats.find((s) => s.pos === result.heroPos);

  const canSave = !props.readOnly && !!props.onSave && !!headline;
  const evLossPreview = headline && action ? evLossOf(headline.heroEv, action) : null;

  function save(): void {
    if (!action || !props.onSave) return;
    props.onSave(action);
    setSaved(true);
  }

  return (
    <div className="result-wrap">
      {headline ? (
        <div className="panel vhero">
          <div className={`verdict ${verdictOf(headline) === 'PUSH' ? 'push' : 'fold'}`}>{verdictOf(headline)}</div>
          <div className="vmeta">
            <b className="vhand">{result.heroHand}</b>
            <span>
              {result.heroPos}・{heroSeat ? `${heroSeat.stack}bb` : ''}・{result.playersLeft} left
            </span>
            <span className="vaction">{ACTION_JA[headline.actionType] ?? headline.actionType}</span>
          </div>
          <div className="evbox">
            <span className="evlabel">EV（フォールド比, 実払い pt）</span>
            <b className={`evval ${evClass(headline.heroEv)}`}>
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

      {/* ---- 記録（自分の実行動を選んで保存） ---- */}
      {canSave && (
        <div className="panel saverec">
          <div className="scr-h sm">この局面での自分の選択</div>
          <div className="seg">
            {(['PUSH', 'FOLD'] as HeroAction[]).map((a) => (
              <button
                key={a}
                type="button"
                className={`segbtn ${action === a ? 'on' : ''}`}
                onClick={() => setAction(a)}
                disabled={saved}
              >
                {a === 'PUSH' ? 'ALL IN' : 'FOLD'}
              </button>
            ))}
          </div>
          {evLossPreview !== null && (
            <p className={`evloss-note ${evLossPreview > 0 ? 'loss' : 'ok'}`}>
              {evLossPreview > 0
                ? `EV loss −${evLossPreview.toFixed(3)} pt（最適は ${verdictOf(headline!) === 'PUSH' ? 'ALL IN' : 'FOLD'}）`
                : 'EV loss 0（最適な選択）'}
            </p>
          )}
          <button type="button" className="btn wide" onClick={save} disabled={!action || saved}>
            {saved ? '記録しました ✓' : '記録する'}
          </button>
        </div>
      )}

      {/* ---- 履歴からの再表示（記録済み情報） ---- */}
      {props.readOnly && props.savedAction && (
        <div className="panel saverec">
          <div className="scr-h sm">記録した選択</div>
          <div className="row">
            <span>自分の選択</span>
            <b>{props.savedAction === 'PUSH' ? 'ALL IN' : 'FOLD'}</b>
          </div>
          <div className="row">
            <span>EV loss（pt）</span>
            <b className={props.savedEvLoss && props.savedEvLoss > 0 ? 'warn' : 'ok'}>
              {(props.savedEvLoss ?? 0) > 0 ? `−${(props.savedEvLoss ?? 0).toFixed(3)}` : '0'}
            </b>
          </div>
        </div>
      )}

      {heroNodes.length > 1 && (
        <div className="panel">
          <div className="scr-h sm">hero の他の状況</div>
          {heroNodes.filter((n) => n !== headline).map((n) => (
            <div key={n.key} className="hnode">
              <span className="ht">{ACTION_JA[n.actionType]?.split(' ')[0] ?? n.actionType}</span>
              <span className={`hv ${verdictOf(n) === 'PUSH' ? 'push' : 'fold'}`}>{verdictOf(n)}</span>
              <span className="hpct">{n.pct.toFixed(1)}%</span>
              <span className={`hev ${evClass(n.heroEv)}`}>
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
        {props.readOnly ? '記録一覧に戻る' : '別のスポットを入力'}
      </button>
    </div>
  );
}
