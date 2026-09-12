import { formatBbDisplay } from '@oshihiki/core';
import { useEffect, useState } from 'react';
import type { SolveResultDto } from '../solverProtocol';
import { RangeGrid } from './RangeGrid';
import {
  activeNode,
  aggressiveFor,
  applyChoice,
  defaultState,
  orderOf,
  treeRows,
  type TreeState,
} from '../tree/model';

/**
 * Action tree（M4）。全ポジションを行動順に常時表示し、各行の FOLD / PU・CA・OC を
 * インライン切替。選択中（active）の行の決定ノードをソルバー出力から引き、下段の
 * レンジ表・頻度・記法を連動表示する。hero の行では自分の手札を強調。BB のウォーク
 * （上流に push 無し）は「no decision」でロック。
 */
export function ActionTree(props: { result: SolveResultDto; stacks?: Record<string, number> }): JSX.Element {
  const { result, stacks } = props;
  const [state, setState] = useState<TreeState>(() => defaultState(result));

  // 新しい求解に切り替わったら初期状態へ（見出しノードを active に）。
  useEffect(() => {
    setState(defaultState(result));
  }, [result]);

  const order = orderOf(result);
  const heroIdx = order.indexOf(result.heroPos);
  const rows = treeRows(result, state);
  const node = activeNode(result, state);
  const activePos = order[state.active]!;
  const activeWalk = rows[state.active]?.walk ?? false;
  const aggrLabel = activeWalk ? null : aggressiveFor(state.actions, state.active).label;

  const pct = node?.pct ?? 0;
  const fold = 100 - pct;

  const note =
    state.active === heroIdx
      ? '自分の判断はこの行です。下の行を切り替えると、後ろの人が何を受けてくるかを見られます。'
      : '後ろの人がどう受けてくるかを見ています。自分の行に戻すと判定に戻ります。';

  return (
    <>
      <div className="tree">
        {rows.map((row) => (
          <div key={row.pos} className="arow" data-active={String(state.active === row.seatIdx)} data-locked={String(row.walk)}>
            <span className={`posbadge sm pos-${row.pos}`}>{row.pos}</span>
            <span className="arow-stack">{stacks && stacks[row.pos] != null ? `${formatBbDisplay(stacks[row.pos]!)}bb` : ''}</span>
            {row.walk ? (
              <span className="term">no decision</span>
            ) : (
              <div className="segs">
                {row.options.map((opt) => (
                  <button
                    key={opt.label}
                    type="button"
                    className={`seg${opt.aggressive ? ' act' : ''}`}
                    aria-pressed={row.current === opt.code}
                    onClick={() => setState((s) => applyChoice(s, row.seatIdx, opt.code))}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <p className="tree-note">{note}</p>

      <div className="rangehdr">
        <span className="scr-h sm">
          {activeWalk || !node ? `${activePos} — no decision` : `${activePos} — ${aggrLabel} range`}
        </span>
      </div>

      {activeWalk || !node ? (
        <div className="freq">
          <div className="ff" style={{ width: '100%' }}>
            全員フォールドで BB が取ります
          </div>
        </div>
      ) : (
        <>
          <div className="freq">
            {pct > 0 && (
              <div className="fp" style={{ width: `${pct}%` }}>
                {pct.toFixed(pct >= 10 ? 0 : 1)}%
              </div>
            )}
            {fold > 0 && (
              <div className="ff" style={{ width: `${fold}%` }}>
                {fold.toFixed(fold >= 10 ? 0 : 1)}%
              </div>
            )}
          </div>
          <RangeGrid hands={node.hands} heroHand={state.active === heroIdx ? result.heroHand : ''} />
          <div className="legend">
            <span>
              <i style={{ background: 'var(--yellow)' }} />
              取るハンド
            </span>
            <span>
              <i style={{ background: 'var(--cell-off)' }} />
              取らない
            </span>
            {state.active === heroIdx && (
              <span style={{ color: 'var(--cyan)' }}>
                <i style={{ background: 'transparent', border: '2px solid var(--cyan)' }} />
                自分の手
              </span>
            )}
          </div>
          <p className="rangestr">{node.range === 'Any two' || node.range === '' ? node.range || '(空)' : node.range}</p>
        </>
      )}
    </>
  );
}
