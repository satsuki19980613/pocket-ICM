import { useState } from 'react';
import type { Position } from '@oshihiki/core';
import type { OcrReadout } from '@oshihiki/ocr';
import { positionsForPlayersLeft } from '@oshihiki/core';
import { HandPicker } from './HandPicker';
import { ImageModal } from './ImageModal';
import { buildBoardState, reconcilePositions, type AnteScheme, type BoardForm } from '../formModel';

/**
 * 手入力モーダル（3-1b・M3）。写真起点（icm）や確認画面の「修正」から開く。妥当なら
 * onSubmit(form) を呼んで確認画面へ。無効なら issues を表示。閉じると呼び出し元へ戻る。
 * 写真経由（imageUrl あり）のときは「元画像を確認」で原寸照合しながら直せる（readout があれば
 * SPEC §5.2.3 の元画像×OCR出力の照合表も一緒に出す）。
 */
export function InputForm(props: {
  form: BoardForm;
  onFormChange: (f: BoardForm) => void;
  onSubmit: (form: BoardForm) => void;
  /** OCR で読み取った元画像（objectURL）。あれば「元画像を確認」ボタンを出す。 */
  imageUrl?: string | null;
  /** OCR 出力（SPEC §5.2.3）。あれば「元画像を確認」モーダルに照合表を出す。 */
  readout?: OcrReadout;
  /** 元画像の寸法（照合表ヘッダの「画像サイズ」用）。 */
  imageSize?: { w: number; h: number };
  /** モーダルを閉じる（背景クリック / ✕ / Esc）。 */
  onClose: () => void;
}): JSX.Element {
  const { form, onFormChange } = props;
  const [showGrid, setShowGrid] = useState(false);
  const [showImage, setShowImage] = useState(false);
  const positions = positionsForPlayersLeft(form.playersLeft);

  const set = (patch: Partial<BoardForm>): void => onFormChange({ ...form, ...patch });
  const setStack = (pos: Position, v: string): void =>
    onFormChange({ ...form, stacks: { ...form.stacks, [pos]: v } });

  const preview = buildBoardState(form);

  return (
    <div
      className="modal-backdrop"
      onClick={props.onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') props.onClose();
      }}
      role="presentation"
    >
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="手入力">
        <div className="modal-head">
          <span className="modal-title">手入力</span>
          {props.imageUrl && (
            <button type="button" className="btn line img-check sm" onClick={() => setShowImage(true)}>
              {props.readout ? '🖼 元画像とOCR結果' : '🖼 元画像を確認'}
            </button>
          )}
          <button type="button" className="modal-x" aria-label="閉じる" onClick={props.onClose}>
            ✕
          </button>
        </div>

        <div className="modal-body form">
          <div className="grp">
            <label className="lbl">残り人数</label>
            <div className="seg">
              {/* 2〜6 人に対応（5〜6 人は直接求解・数秒〜十数秒）。 */}
              {[2, 3, 4, 5, 6].map((n) => (
                <button
                  key={n}
                  type="button"
                  className={`segbtn${form.playersLeft === n ? ' on' : ''}`}
                  onClick={() => onFormChange(reconcilePositions({ ...form, playersLeft: n }))}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          <div className="grp2">
            <div>
              <label className="lbl">SB</label>
              <input className="inp" inputMode="decimal" value={form.sb} onChange={(e) => set({ sb: e.target.value })} />
            </div>
            <div>
              <label className="lbl">BB</label>
              <input className="inp" inputMode="decimal" value={form.bb} onChange={(e) => set({ bb: e.target.value })} />
            </div>
          </div>

          <div className="grp2">
            <div>
              <label className="lbl">アンティ方式</label>
              <select
                className="inp"
                value={form.anteScheme}
                onChange={(e) => set({ anteScheme: e.target.value as AnteScheme })}
              >
                <option value="none">なし</option>
                <option value="all">全員払い (all)</option>
                <option value="bb">BBアンティ (bb)</option>
              </select>
            </div>
            <div>
              <label className="lbl">アンティ額 (bb)</label>
              <input
                className="inp"
                inputMode="decimal"
                value={form.anteAmount}
                disabled={form.anteScheme === 'none'}
                onChange={(e) => set({ anteAmount: e.target.value })}
              />
            </div>
          </div>

          <div className="grp">
            <label className="lbl">スタック (bb) ・ hero を選択</label>
            <div className="seats">
              {positions.map((pos) => (
                <div key={pos} className={`seatrow${form.heroPos === pos ? ' hero' : ''}`}>
                  <button
                    type="button"
                    className={`posbadge pos-${pos}${form.heroPos === pos ? ' on' : ''}`}
                    onClick={() => set({ heroPos: pos })}
                    title="hero に設定"
                  >
                    {pos}
                  </button>
                  <input
                    className="inp stack"
                    inputMode="decimal"
                    value={form.stacks[pos] ?? ''}
                    onChange={(e) => setStack(pos, e.target.value)}
                  />
                  <span className="bb">bb{pos === form.heroPos ? ' ← hero' : ''}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="grp">
            <label className="lbl">hero ハンド</label>
            <div className="handrow">
              <button type="button" className="handbtn" onClick={() => setShowGrid((s) => !s)}>
                {form.heroHand} <span className="chev">{showGrid ? '▲' : '▼'}</span>
              </button>
            </div>
            {showGrid && (
              <HandPicker
                value={form.heroHand}
                onChange={(h) => {
                  set({ heroHand: h });
                  setShowGrid(false);
                }}
              />
            )}
          </div>

          {!preview.ok && preview.issues.length > 0 && (
            <ul className="issues">
              {preview.issues.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          )}

          <button type="button" className="btn wide" disabled={!preview.ok} onClick={() => props.onSubmit(form)}>
            この内容で確認する
          </button>
        </div>
      </div>

      {showImage && props.imageUrl && (
        <ImageModal
          src={props.imageUrl}
          readout={props.readout}
          imageSize={props.imageSize}
          onClose={() => setShowImage(false)}
        />
      )}
    </div>
  );
}
