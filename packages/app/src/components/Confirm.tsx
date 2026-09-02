import type { BoardState } from '@oshihiki/core';
import { potChecksumDelta } from '@oshihiki/core';

/** 条件確認（§7.1）。組み立てた盤面の読み上げ＋ポット検算。修正 / 計算する。 */
export function Confirm(props: {
  state: BoardState;
  /** OCR 由来の低信頼フィールド（"UTG.stack" / "UTG.bet"）。強調表示する。 */
  lowConfidenceFields?: string[];
  onEdit: () => void;
  onSolve: () => void;
}): JSX.Element {
  const { state } = props;
  const low = new Set(props.lowConfidenceFields ?? []);
  const hasLow = low.size > 0;
  const anteText =
    state.ante.scheme === 'none' ? 'なし' : `${state.ante.scheme} ${state.ante.amount}bb`;
  const delta = potChecksumDelta(state);
  const potOk = delta !== null && Math.abs(delta) < 1e-9;

  return (
    <div className="panel confirm">
      <h2 className="scr-h">条件確認</h2>

      <div className="readout">
        <div className="row"><span>ブラインド</span><b>{state.blinds.sb} / {state.blinds.bb}</b></div>
        <div className="row"><span>アンティ</span><b>{anteText}</b></div>
        <div className="row"><span>hero ハンド</span><b>{state.heroHand}</b></div>
        <div className="row"><span>hero ポジション</span><b>{state.heroPos}</b></div>
        <div className="row"><span>残り人数</span><b>{state.playersLeft}</b></div>
        <div className="row">
          <span>ポット検算</span>
          <b className={potOk ? 'ok' : 'warn'}>
            {potOk ? `一致 (${state.pot}bb)` : `不一致 Δ=${delta?.toFixed(2)}`}
          </b>
        </div>
      </div>

      {hasLow && (
        <p className="lowconf-note">
          ⚠️ 黄色の項目は自動読取の信頼度が低めです。値をご確認ください（修正は「修正」から）。
        </p>
      )}

      <div className="seats-ro">
        {state.seats.map((s) => (
          <div key={s.pos} className={`seatrow-ro${s.pos === state.heroPos ? ' hero' : ''}`}>
            <span className="posbadge sm">{s.pos}</span>
            <span className={`stk${low.has(`${s.pos}.stack`) ? ' lowconf' : ''}`}>{s.stack}bb</span>
            {s.bet > 0 && (
              <span className={`betchip${low.has(`${s.pos}.bet`) ? ' lowconf' : ''}`}>bet {s.bet}</span>
            )}
            {s.pos === state.heroPos && <span className="herotag">hero</span>}
          </div>
        ))}
      </div>

      <div className="btnrow">
        <button type="button" className="btn ghost" onClick={props.onEdit}>
          修正
        </button>
        <button type="button" className="btn" onClick={props.onSolve}>
          この内容で計算する
        </button>
      </div>
    </div>
  );
}
