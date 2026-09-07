import { useState } from 'react';
import type { BoardState } from '@oshihiki/core';
import { potChecksumDelta } from '@oshihiki/core';
import { ImageModal } from './ImageModal';

/**
 * 条件確認（3-1c・M3）。読み取った内容を項目別に読み上げ、各行の「修正」で手入力
 * モーダルを開く。OCR 低信頼フィールドは CHECK バッジで強調。ポット検算も表示。
 * 写真経由（imageUrl あり）のときは「元画像を確認」で原寸照合できる。
 */
export function Confirm(props: {
  state: BoardState;
  /** OCR 由来の低信頼フィールド（"UTG.stack" / "UTG.bet"）。強調表示する。 */
  lowConfidenceFields?: string[];
  /** OCR で読み取った元画像（objectURL）。あれば「元画像を確認」ボタンを出す。 */
  imageUrl?: string | null;
  /** 手入力モーダルを開く（項目別「修正」・全体「修正」共通）。 */
  onEdit: () => void;
  onSolve: () => void;
}): JSX.Element {
  const { state } = props;
  const [showImage, setShowImage] = useState(false);
  const low = new Set(props.lowConfidenceFields ?? []);
  const hasLow = low.size > 0;
  const anteText = state.ante.scheme === 'none' ? 'なし' : `${state.ante.scheme} ${state.ante.amount}bb`;
  const delta = potChecksumDelta(state);
  const potOk = delta !== null && Math.abs(delta) < 1e-9;
  // 席スタックのいずれかが低信頼なら Players 行を CHECK 強調（モックの low 行に対応）。
  const stacksLow = state.seats.some((s) => low.has(`${s.pos}.stack`));

  const Edit = (): JSX.Element => (
    <button type="button" className="edit" onClick={props.onEdit}>
      修正
    </button>
  );

  return (
    <div className="panel confirm">
      <div className="confirm-head">
        <h2 className="scr-h">読み取った内容</h2>
        {props.imageUrl && (
          <button type="button" className="btn line img-check" onClick={() => setShowImage(true)}>
            🖼 元画像を確認
          </button>
        )}
      </div>

      <div className="readout">
        <div className="row">
          <span className="lb">Blinds</span>
          <span className="vl">
            {state.blinds.sb} / {state.blinds.bb}
            {state.ante.scheme !== 'none' && <>　ante {state.ante.amount}</>}
          </span>
          <Edit />
        </div>
        <div className="row">
          <span className="lb">Hand</span>
          <span className="vl">{state.heroHand}</span>
          <Edit />
        </div>
        <div className="row">
          <span className="lb">Hero</span>
          <span className="vl">{state.heroPos}</span>
          <Edit />
        </div>
        <div className={`row${stacksLow ? ' low' : ''}`}>
          <span className="lb">Players</span>
          <span className="vl">{state.playersLeft}</span>
          <Edit />
        </div>
        <div className="row">
          <span className="lb">Pot</span>
          <span className={`vl ${potOk ? 'ok' : 'warn'}`}>
            {potOk ? `一致 (${state.pot}bb)` : `不一致 Δ=${delta?.toFixed(2)}`}
          </span>
          <Edit />
        </div>
      </div>

      {hasLow && (
        <p className="lowconf-note">
          ⚠️ CHECK の付いた項目は自動読取の信頼度が低めです。値をご確認ください（「修正」から直せます）。
        </p>
      )}

      <h2 className="scr-h sm" style={{ marginTop: 'var(--s4)' }}>
        Stacks
      </h2>
      <div className="seats-ro">
        {state.seats.map((s) => (
          <div key={s.pos} className={`seatrow-ro${s.pos === state.heroPos ? ' hero' : ''}`}>
            <span className={`posbadge sm pos-${s.pos}`}>{s.pos}</span>
            <span className={`stk${low.has(`${s.pos}.stack`) ? ' lowconf' : ''}`}>{s.stack}bb</span>
            {s.bet > 0 && (
              <span className={`betchip${low.has(`${s.pos}.bet`) ? ' lowconf' : ''}`}>bet {s.bet}</span>
            )}
            {s.pos === state.heroPos && <span className="herotag">hero</span>}
          </div>
        ))}
      </div>

      <p className="confirm-note">違っていたら「修正」から直せます。直した内容がそのまま計算に使われます。</p>

      <div className="btnrow">
        <button type="button" className="btn ghost" onClick={props.onEdit}>
          修正
        </button>
        <button type="button" className="btn" onClick={props.onSolve}>
          この内容で計算する
        </button>
      </div>

      {showImage && props.imageUrl && <ImageModal src={props.imageUrl} onClose={() => setShowImage(false)} />}
    </div>
  );
}
