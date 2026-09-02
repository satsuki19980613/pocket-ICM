import { useState } from 'react';
import type { BoardState } from '@oshihiki/core';
import { InputForm } from './components/InputForm';
import { Confirm } from './components/Confirm';
import { Result } from './components/Result';
import { ErrorView } from './components/ErrorView';
import { buildBoardState, defaultForm, type BoardForm } from './formModel';
import { solveInWorker } from './solverClient';
import type { SolveResultDto } from './solverProtocol';
import { prefillFromScreenshot } from './ocr/screenshotPrefill';

type Screen = 'form' | 'confirm' | 'solving' | 'result' | 'error';

/**
 * 人数に応じた求解パラメータ。ショーダウン MC は Web Worker 並列（mcPool）なので
 * 反復・サンプルを厚めに取れる。exploitability がしきい値に達すれば早期終了する。
 */
function solveOptsForN(n: number): { maxIters?: number; samples?: number } {
  switch (n) {
    case 2:
      return {};
    case 3:
      return { maxIters: 600, samples: 50_000 };
    case 4:
      return { maxIters: 600, samples: 40_000 };
    case 5:
      return { maxIters: 600, samples: 32_000 };
    default:
      return { maxIters: 500, samples: 24_000 };
  }
}

export function App(): JSX.Element {
  const [screen, setScreen] = useState<Screen>('form');
  const [form, setForm] = useState<BoardForm>(() => defaultForm(5));
  const [state, setState] = useState<BoardState | null>(null);
  const [result, setResult] = useState<SolveResultDto | null>(null);
  const [ms, setMs] = useState(0);
  const [issues, setIssues] = useState<string[]>([]);
  // OCR プリフィルの低信頼フィールド（"UTG.stack" 等）。確認画面で強調する。
  const [lowConf, setLowConf] = useState<string[]>([]);
  const [ocrBusy, setOcrBusy] = useState(false);

  function toConfirm(f: BoardForm): void {
    // 手入力からの遷移は OCR 由来の強調を持ち越さない。
    setLowConf([]);
    const built = buildBoardState(f);
    if (!built.ok || !built.state) {
      setIssues(built.issues);
      setScreen('error');
      return;
    }
    setState(built.state);
    setScreen('confirm');
  }

  /**
   * スクショ添付 → OCR プリフィル。成功なら手入力フォームを埋めて条件確認へ
   * （SPEC §6.1: 必ず確認画面を経由し全項目修正可能）。読取失敗・対象外フレームは
   * issues を表示して手入力継続に委ねる。
   */
  async function onScreenshot(file: File): Promise<void> {
    setOcrBusy(true);
    try {
      const res = await prefillFromScreenshot(file);
      if (!res.ok || !res.form) {
        setIssues([
          'スクリーンショットから局面を読み取れませんでした（対象はプリフロップ終了フレーム）。',
          ...res.issues,
        ]);
        setScreen('error');
        return;
      }
      setForm(res.form);
      const built = buildBoardState(res.form);
      if (!built.ok || !built.state) {
        setIssues(['OCR 結果の組み立てに失敗しました。手入力で修正してください。', ...built.issues]);
        setScreen('error');
        return;
      }
      setLowConf(res.lowConfidenceFields);
      setState(built.state);
      setScreen('confirm');
    } catch (e) {
      setIssues(['スクリーンショットの読み込みに失敗しました。', e instanceof Error ? e.message : String(e)]);
      setScreen('error');
    } finally {
      setOcrBusy(false);
    }
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
        <h1>Black Ops ICM</h1>
        <span className="tag">Phase 3-1 · 手入力ICM</span>
      </header>

      {screen === 'form' && (
        <InputForm
          form={form}
          onFormChange={setForm}
          onSubmit={toConfirm}
          onScreenshot={onScreenshot}
          ocrBusy={ocrBusy}
        />
      )}

      {screen === 'confirm' && state && (
        <Confirm
          state={state}
          lowConfidenceFields={lowConf}
          onEdit={() => setScreen('form')}
          onSolve={solve}
        />
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
