import { useState } from 'react';
import type { BoardState } from '@oshihiki/core';
import { InputForm } from './components/InputForm';
import { Confirm } from './components/Confirm';
import { Result } from './components/Result';
import { ErrorView } from './components/ErrorView';
import { buildBoardState, defaultForm, type BoardForm } from './formModel';
import { solveInWorker } from './solverClient';
import type { SolveResultDto } from './solverProtocol';

type Screen = 'form' | 'confirm' | 'solving' | 'result' | 'error';

/** 人数に応じた求解パラメータ（対話速度優先。5〜6人はブラウザ並列化まで暫定）。 */
function solveOptsForN(n: number): { maxIters?: number; samples?: number } {
  switch (n) {
    case 2:
      return {};
    case 3:
      return { maxIters: 300, samples: 40_000 };
    case 4:
      return { maxIters: 200, samples: 30_000 };
    case 5:
      return { maxIters: 150, samples: 22_000 };
    default:
      return { maxIters: 100, samples: 16_000 };
  }
}

export function App(): JSX.Element {
  const [screen, setScreen] = useState<Screen>('form');
  const [form, setForm] = useState<BoardForm>(() => defaultForm(5));
  const [state, setState] = useState<BoardState | null>(null);
  const [result, setResult] = useState<SolveResultDto | null>(null);
  const [ms, setMs] = useState(0);
  const [issues, setIssues] = useState<string[]>([]);

  function toConfirm(f: BoardForm): void {
    const built = buildBoardState(f);
    if (!built.ok || !built.state) {
      setIssues(built.issues);
      setScreen('error');
      return;
    }
    setState(built.state);
    setScreen('confirm');
  }

  async function solve(): Promise<void> {
    if (!state) return;
    setScreen('solving');
    try {
      const { result: dto, ms: elapsed } = await solveInWorker(state, solveOptsForN(state.playersLeft));
      setResult(dto);
      setMs(elapsed);
      setScreen('result');
    } catch (e) {
      setIssues([e instanceof Error ? e.message : String(e)]);
      setScreen('error');
    }
  }

  return (
    <div className="app">
      <header className="hdr">
        <h1>押し引きノート</h1>
        <span className="tag">Phase 3-1 · 手入力ICM</span>
      </header>

      {screen === 'form' && (
        <InputForm form={form} onFormChange={setForm} onSubmit={toConfirm} />
      )}

      {screen === 'confirm' && state && (
        <Confirm state={state} onEdit={() => setScreen('form')} onSolve={solve} />
      )}

      {screen === 'solving' && (
        <div className="panel solving">
          <div className="spinner" />
          <p>求解中…（端末内 Web Worker）</p>
          <p className="sub">人数が多いほど時間がかかります（並列化は後続）。</p>
        </div>
      )}

      {screen === 'result' && state && result && (
        <Result state={state} result={result} ms={ms} onBack={() => setScreen('form')} />
      )}

      {screen === 'error' && (
        <ErrorView issues={issues} onBack={() => setScreen('form')} />
      )}

      <footer className="ft">
        端末ローカル完結・RTA なし。数値は実払い pt。求解は端末内（Web Worker）。
      </footer>
    </div>
  );
}
