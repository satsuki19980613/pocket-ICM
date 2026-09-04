import { useState } from 'react';
import type { BoardState } from '@oshihiki/core';
import type { SolveResultDto } from '../solverProtocol';
import { ActionTree } from './ActionTree';
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
  /** 記録の保存ハンドラ（読み取り専用の再表示時は未指定）。published=ホーム公開フラグ（既定 false）。 */
  onSave?: (heroAction: HeroAction, published: boolean) => void;
  /** 履歴からの再表示（保存 UI を出さず、記録済みの情報を表示）。 */
  readOnly?: boolean;
  /** readOnly 時に表示する、記録済みの実行動と EV loss。 */
  savedAction?: HeroAction;
  savedEvLoss?: number;
  savedPublished?: boolean;
  /** 戻るボタンの文言（未指定なら readOnly=記録一覧 / 通常=別のスポット）。 */
  backLabel?: string;
}): JSX.Element {
  const { result, state } = props;
  const [action, setAction] = useState<HeroAction | null>(null);
  const [publish, setPublish] = useState(false);
  const [saved, setSaved] = useState(false);
  const headline = headlineNode(result);
  const heroSeat = state.seats.find((s) => s.pos === result.heroPos);

  const canSave = !props.readOnly && !!props.onSave && !!headline;
  const evLossPreview = headline && action ? evLossOf(headline.heroEv, action) : null;

  function save(): void {
    if (!action || !props.onSave) return;
    props.onSave(action, publish);
    setSaved(true);
  }

  return (
    <div className="result-wrap">
      {headline ? (
        <div className={`panel vhero ${verdictOf(headline) === 'PUSH' ? '' : 'fold'}`}>
          <div className={`verdict ${verdictOf(headline) === 'PUSH' ? 'push' : 'fold'}`}>{verdictOf(headline)}</div>
          <div className="vmeta">
            <b className="vhand">{result.heroHand}</b>
            <span>
              {result.heroPos}・{heroSeat ? `${heroSeat.stack}bb` : ''}・{result.playersLeft} left
            </span>
            <span className="vaction">
              {ACTION_JA[headline.actionType] ?? headline.actionType}・レンジ {headline.pct.toFixed(1)}%
            </span>
          </div>
          <div className="evbox">
            <span className="evlabel">EV（フォールド比, 実払い pt）</span>
            <b className={`evval ${evClass(headline.heroEv)}`}>
              {headline.heroEv >= 0 ? '+' : ''}
              {headline.heroEv.toFixed(3)}
            </b>
          </div>
        </div>
      ) : (
        <div className="panel">hero の決定ノードがありません（BB のウォーク等）。下の Action tree を参照。</div>
      )}

      <div className="panel">
        <h2 className="scr-h">Action tree</h2>
        <ActionTree result={result} />
      </div>

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
          <div className="tog">
            <div>
              ホームで公開する
              <small>クラブのみんなが見られ、スレッドで話せます（公開の反映は後日）</small>
            </div>
            <button
              type="button"
              className="sw"
              role="switch"
              aria-checked={publish}
              aria-label="ホームで公開する"
              onClick={() => setPublish((p) => !p)}
              disabled={saved}
            />
          </div>
          <button type="button" className="btn wide" onClick={save} disabled={!action || saved}>
            {saved ? `記録しました ✓${publish ? '（公開）' : ''}` : '記録する'}
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
          <div className="row">
            <span>公開状態</span>
            <b>
              <span className={`tag${props.savedPublished ? ' pub' : ''}`}>
                {props.savedPublished ? '公開中' : '非公開'}
              </span>
            </b>
          </div>
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

      <button type="button" className="btn ghost wide" onClick={props.onBack}>
        {props.backLabel ?? (props.readOnly ? '記録一覧に戻る' : '別のスポットを入力')}
      </button>
    </div>
  );
}
