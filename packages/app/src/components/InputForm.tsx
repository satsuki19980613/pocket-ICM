import { useState } from 'react';
import type { Position } from '@oshihiki/core';
import { positionsForPlayersLeft } from '@oshihiki/core';
import { HandPicker } from './HandPicker';
import { buildBoardState, reconcilePositions, type AnteScheme, type BoardForm } from '../formModel';

/** 手入力フォーム（3-1b）。妥当なら onSubmit(state) を呼ぶ。無効なら issues を表示。 */
export function InputForm(props: {
  form: BoardForm;
  onFormChange: (f: BoardForm) => void;
  onSubmit: (form: BoardForm) => void;
}): JSX.Element {
  const { form, onFormChange } = props;
  const [showGrid, setShowGrid] = useState(false);
  const positions = positionsForPlayersLeft(form.playersLeft);

  const set = (patch: Partial<BoardForm>): void => onFormChange({ ...form, ...patch });
  const setStack = (pos: Position, v: string): void =>
    onFormChange({ ...form, stacks: { ...form.stacks, [pos]: v } });

  const preview = buildBoardState(form);

  return (
    <div className="panel form">
      <div className="grp">
        <label className="lbl">残り人数</label>
        <div className="seg">
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
                className={`posbadge${form.heroPos === pos ? ' on' : ''}`}
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

      <button type="button" className="btn" disabled={!preview.ok} onClick={() => props.onSubmit(form)}>
        条件を確認する
      </button>
    </div>
  );
}
