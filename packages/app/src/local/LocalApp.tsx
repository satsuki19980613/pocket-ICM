/**
 * ローカル版（ICM 読み取り専用）。
 *
 * 本体 App.tsx から「スクショ読み取り → 条件確認 → 求解 → 結果 → 記録」だけを抜き出したもの。
 * ログイン・サーバ同期（Supabase）・ホームフィード・Training・SIT & GO・管理画面は持たない。
 * OCR も求解もすべて端末内（ブラウザ・Web Worker）で完結し、記録は IndexedDB にだけ残る。
 *
 * 画面部品（IcmInput / Confirm / InputForm / Result / RecordsView / ErrorView）は本体と共有する。
 * 本体側で直った読み取り精度・求解の改善は、そのままこちらにも乗る。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { BoardState, GameMode } from '@oshihiki/core';
import { GAME_MODES, gameModeLabel } from '@oshihiki/core';
import type { OcrReadout, RawReads } from '@oshihiki/ocr';
import { IcmInput } from '../components/IcmInput';
import { DEFAULT_GAME_SEL, selFromMode, selectedMode, type GameSel } from '../components/GameModeSelect';
import { InputForm } from '../components/InputForm';
import { Confirm } from '../components/Confirm';
import { Result } from '../components/Result';
import { ErrorView } from '../components/ErrorView';
import { Background } from '../components/Background';
import { RecordsView } from '../components/RecordsView';
import { Toast } from '../components/Toast';
import { UpdateBanner } from '../components/UpdateBanner';
import { reportAppIdle } from '../pwa/appUpdate';
import { reprefillForGameMode } from '../ocr/prefill';
import { prefillFromScreenshot, type OcrPrefillResult } from '../ocr/screenshotPrefill';
import { buildBoardState, defaultForm, reconcilePositions, type BoardForm } from '../formModel';
import { solveInWorker } from '../solverClient';
import type { SolveResultDto } from '../solverProtocol';
import { evLossOf, finishRecord, headlineNode, startRecord, type HeroAction, type SpotRecord } from '../records/model';
import { deleteRecord, listRecords, putRecord } from '../records/store';
import { IDLE_JOB, canStartSolve, completeJob, createStartLatch, failJob, startJob, type SolveJob } from '../solveJob';
import { LocalErrorBoundary } from './LocalErrorBoundary';

type Screen = 'icm' | 'confirm' | 'error' | 'result' | 'history';

const TITLES: Record<Screen, string> = {
  icm: 'ICM',
  confirm: '条件確認',
  error: '条件確認',
  result: '計算結果',
  history: '記録',
};

/** 下段タブを出す画面。 */
const TAB_SCREENS: Screen[] = ['icm', 'history'];

/** 本体と同じ上限（ポーカーチェイスは 6 人卓まで）。 */
const MAX_PLAYERS = 6;
const DEFAULT_PLAYERS = 4;
const OVER_SCOPE_MSG = `現在は${MAX_PLAYERS}人までの局面に対応しています。`;

/** 人数に応じた求解パラメータ（本体 App.tsx の solveOptsForN と同じ値）。 */
function solveOptsForN(n: number): { maxIters?: number; samples?: number } {
  switch (n) {
    case 2:
      return {};
    case 3:
      return { maxIters: 1500, samples: 50_000 };
    case 4:
      return { maxIters: 2000, samples: 40_000 };
    case 5:
      return { maxIters: 3000, samples: 32_000 };
    default:
      return { maxIters: 3000, samples: 24_000 };
  }
}

/** ゲーム選択の保存キー（本体とは別オリジンで動く想定だが、念のためキーも分ける）。 */
const GAME_MODE_KEY = 'icmlocal.gameMode';

interface ToastState {
  key: number;
  message: string;
  kind: 'done' | 'err';
  onTap: () => void;
}

export function LocalApp(): JSX.Element {
  const [screen, setScreen] = useState<Screen>('icm');
  const [manualOpen, setManualOpen] = useState(false);
  const [errFromPhoto, setErrFromPhoto] = useState(false);

  const [gameSel, setGameSel] = useState<GameSel>(() => {
    try {
      const saved = localStorage.getItem(GAME_MODE_KEY);
      if (saved && (GAME_MODES as readonly string[]).includes(saved)) return selFromMode(saved as GameMode);
    } catch {
      /* localStorage が使えなくても既定で動く。 */
    }
    return DEFAULT_GAME_SEL;
  });
  const gameMode = selectedMode(gameSel);

  const [modeMismatch, setModeMismatch] = useState(false);
  const [modeNote, setModeNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [stackRecovered, setStackRecovered] = useState(false);
  const [unresolvedStacks, setUnresolvedStacks] = useState<string[]>([]);
  const [ocrReads, setOcrReads] = useState<RawReads | null>(null);
  const [ocrEdited, setOcrEdited] = useState(false);

  const [form, setForm] = useState<BoardForm>(() => defaultForm(DEFAULT_PLAYERS, gameMode));
  const [state, setState] = useState<BoardState | null>(null);
  const [result, setResult] = useState<SolveResultDto | null>(null);
  const [ms, setMs] = useState(0);
  const [issues, setIssues] = useState<string[]>([]);
  const [lowConf, setLowConf] = useState<string[]>([]);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrImageUrl, setOcrImageUrl] = useState<string | null>(null);
  const [readout, setReadout] = useState<OcrReadout | undefined>(undefined);
  const [imageSize, setImageSize] = useState<{ w: number; h: number } | undefined>(undefined);

  const [records, setRecords] = useState<SpotRecord[]>([]);
  const [resultRec, setResultRec] = useState<SpotRecord | null>(null);
  const [solveJob, setSolveJob] = useState<SolveJob>(IDLE_JOB);
  const startingRef = useRef(createStartLatch());
  const [toast, setToast] = useState<ToastState | null>(null);

  // ---------------------------------------------------------------- 記録

  const refreshRecords = useCallback(async (): Promise<void> => {
    try {
      setRecords(await listRecords());
    } catch {
      /* IndexedDB 不可の環境では履歴は空のまま。 */
    }
  }, []);

  useEffect(() => {
    void (async () => {
      // 前回、計算中のままページを閉じた記録は「中断」に落とす（ローカル版はサーバが無いので自前で）。
      try {
        const all = await listRecords();
        for (const r of all) {
          if (r.status === 'solving') await putRecord({ ...r, status: 'aborted' });
        }
      } catch {
        /* noop */
      }
      await refreshRecords();
    })();
  }, [refreshRecords]);

  function showToast(message: string, kind: 'done' | 'err', onTap: () => void): void {
    setToast({ key: Date.now(), message, kind, onTap });
  }

  function openRecord(rec: SpotRecord): void {
    if (rec.status !== 'done' || !rec.result) return;
    setResultRec(rec);
    setState(rec.state);
    setResult(rec.result);
    setMs(rec.ms);
    setScreen('result');
  }

  async function onSelectAction(rec: SpotRecord, action: HeroAction | null): Promise<{ ok: boolean; message?: string }> {
    const head = rec.result ? headlineNode(rec.result) : null;
    const evLoss = action != null && head ? evLossOf(head.heroEv, action) : null;
    const updated: SpotRecord = { ...rec, heroAction: action, evLoss };
    try {
      await putRecord(updated);
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : '保存に失敗しました' };
    }
    setResultRec(updated);
    await refreshRecords();
    return { ok: true };
  }

  async function onDeleteRecord(rec: SpotRecord): Promise<void> {
    await deleteRecord(rec.id).catch(() => undefined);
    await refreshRecords();
  }

  // ---------------------------------------------------------------- ゲーム選択・読み直し

  function changeGameSel(next: GameSel): void {
    setGameSel(next);
    const mode = selectedMode(next);
    setForm((f) => ({ ...f, gameMode: mode }));
    setState((st) => (st ? { ...st, gameMode: mode } : st));
    try {
      localStorage.setItem(GAME_MODE_KEY, mode);
    } catch {
      /* noop */
    }
    if (screen === 'confirm' && ocrReads) applyOcrForMode(ocrReads, mode);
    else setModeNote(null);
  }

  function applyOcrForMode(
    reads: RawReads,
    mode: GameMode,
    force = false,
  ): { res: OcrPrefillResult; state?: BoardState } {
    const res = reprefillForGameMode(reads, mode, imageSize);
    const label = gameModeLabel(mode);
    setReadout(res.readout);
    if (!res.ok || !res.form) {
      setModeMismatch(true);
      setModeNote({
        ok: false,
        text: `この写真は「${label}」としては読み取れませんでした。表示中の値は切り替える前のままです。`,
      });
      return { res };
    }
    setModeMismatch(!!res.modeMismatch);
    setUnresolvedStacks(res.unresolvedStacks ?? []);
    if (ocrEdited && !force) {
      setModeNote({ ok: true, text: `「${label}」で計算します（手で直した値はそのまま使います）。` });
      return { res };
    }
    setStackRecovered(!!res.stackRecovered);
    setForm(res.form);
    setLowConf(res.lowConfidenceFields);
    const built = buildBoardState(res.form);
    if (built.ok && built.state) setState(built.state);
    setModeNote({ ok: true, text: `「${label}」として読み直しました。下の内容をご確認ください。` });
    return { res, state: built.ok ? built.state : undefined };
  }

  function rereadForSelectedMode(): void {
    if (!ocrReads) return;
    const { res, state: next } = applyOcrForMode(ocrReads, gameMode, true);
    if (!res.ok || !res.form || !next) {
      if (screen === 'error') {
        setIssues([`この写真は「${gameModeLabel(gameMode)}」としては読み取れませんでした。`, ...res.issues]);
      }
      return;
    }
    if (next.playersLeft > MAX_PLAYERS) {
      setIssues([OVER_SCOPE_MSG]);
      setScreen('error');
      return;
    }
    setOcrEdited(false);
    setScreen('confirm');
  }

  // ---------------------------------------------------------------- 入力

  function setOcrImage(url: string | null): void {
    setOcrImageUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return url;
    });
  }

  function startFreshManual(): void {
    setOcrImage(null);
    setReadout(undefined);
    setImageSize(undefined);
    setOcrReads(null);
    setOcrEdited(false);
    setModeNote(null);
    setManualOpen(true);
  }

  function submitManual(f: BoardForm): void {
    setManualOpen(false);
    setOcrEdited(true);
    setLowConf([]);
    setModeNote(null);
    const built = buildBoardState(f);
    if (!built.ok || !built.state) {
      setErrFromPhoto(false);
      setIssues(built.issues);
      setScreen('error');
      return;
    }
    setState(built.state);
    setScreen('confirm');
  }

  async function onScreenshot(file: File): Promise<void> {
    setOcrBusy(true);
    setErrFromPhoto(true);
    setOcrImage(URL.createObjectURL(file));
    setReadout(undefined);
    setImageSize(undefined);
    setOcrReads(null);
    setOcrEdited(false);
    setModeNote(null);
    try {
      const res = await prefillFromScreenshot(file, gameMode);
      setOcrReads(res.reads ?? null);
      setModeMismatch(!!res.modeMismatch);
      setStackRecovered(!!res.stackRecovered);
      setUnresolvedStacks(res.unresolvedStacks ?? []);
      setReadout(res.readout);
      setImageSize(res.imageSize);

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
      if (built.state.playersLeft > MAX_PLAYERS) {
        setIssues([OVER_SCOPE_MSG]);
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

  // ---------------------------------------------------------------- 求解

  async function runSolve(rec: SpotRecord, finalState: BoardState): Promise<void> {
    try {
      const { result: dto, ms: elapsed } = await solveInWorker(finalState, solveOptsForN(finalState.playersLeft));
      const finished = finishRecord(rec, { result: dto, ms: elapsed });
      try {
        await putRecord(finished);
      } catch {
        /* noop */
      }
      await refreshRecords();
      setSolveJob((j) => (j.recordId === rec.id ? completeJob(j) : j));
      showToast('計算が完了しました', 'done', () => openRecord(finished));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      try {
        await putRecord({ ...rec, status: 'failed', error: message });
      } catch {
        /* noop */
      }
      await refreshRecords();
      setSolveJob((j) => (j.recordId === rec.id ? failJob(j) : j));
      showToast('計算に失敗しました', 'err', () => setScreen('history'));
    }
  }

  async function solve(): Promise<void> {
    if (!state) return;
    if (!canStartSolve(solveJob)) return;
    if (!startingRef.current.acquire()) return;
    let started = false;
    try {
      if (state.playersLeft > MAX_PLAYERS) {
        setErrFromPhoto(false);
        setIssues([OVER_SCOPE_MSG]);
        setScreen('error');
        return;
      }
      const finalState = state;
      const rec = startRecord({
        clientId: crypto.randomUUID(),
        state: finalState,
        heroHand: finalState.heroHand,
        heroPos: finalState.heroPos,
        playersLeft: finalState.playersLeft,
      });
      try {
        await putRecord(rec);
      } catch {
        /* IndexedDB 不可でも計算は続ける。 */
      }
      await refreshRecords();
      setSolveJob(startJob(rec.id));
      setScreen('history');
      started = true;
      void runSolve(rec, finalState).finally(() => startingRef.current.release());
    } finally {
      if (!started) startingRef.current.release();
    }
  }

  async function onRetryRecord(rec: SpotRecord): Promise<void> {
    if (!canStartSolve(solveJob)) return;
    if (!startingRef.current.acquire()) return;
    let started = false;
    try {
      const restarted: SpotRecord = { ...rec, status: 'solving', error: undefined, result: null };
      try {
        await putRecord(restarted);
      } catch {
        /* noop */
      }
      await refreshRecords();
      setSolveJob(startJob(restarted.id));
      started = true;
      void runSolve(restarted, restarted.state).finally(() => startingRef.current.release());
    } finally {
      if (!started) startingRef.current.release();
    }
  }

  // ---------------------------------------------------------------- 表示

  const jobRunning = solveJob.status === 'running';
  const showTabs = TAB_SCREENS.includes(screen);

  // 一覧画面で、入力中でも計算中でもないときだけ、アプリ更新を裏で入れ替えてよい。
  const appIdle = TAB_SCREENS.includes(screen) && !manualOpen && !ocrBusy && !jobRunning;
  useEffect(() => {
    reportAppIdle(appIdle);
  }, [appIdle]);

  function backFor(s: Screen): (() => void) | null {
    switch (s) {
      case 'confirm':
      case 'error':
        return () => setScreen('icm');
      case 'result':
        return () => setScreen('history');
      default:
        return null;
    }
  }
  const back = backFor(screen);

  return (
    <div className={`app${showTabs ? ' has-tabs' : ''}`}>
      <Background />
      <header className="topbar">
        {back ? (
          <button type="button" className="tb-back" aria-label="戻る" onClick={back}>
            ‹
          </button>
        ) : (
          <span className="tb-sp" />
        )}
        <h1 className="tb-title">{TITLES[screen]}</h1>
        <span className="tb-sp" />
      </header>

      <UpdateBanner blocked={jobRunning} />

      <LocalErrorBoundary key={screen} onReset={() => setScreen('icm')}>
        {screen === 'icm' && (
          <IcmInput
            onScreenshot={(f) => void onScreenshot(f)}
            onManual={startFreshManual}
            ocrBusy={ocrBusy}
            blocked={jobRunning}
            gameSel={gameSel}
            onGameModeChange={changeGameSel}
          />
        )}

        {screen === 'confirm' && state && (
          <Confirm
            state={state}
            lowConfidenceFields={lowConf}
            imageUrl={ocrImageUrl}
            readout={readout}
            imageSize={imageSize}
            onEdit={() => setManualOpen(true)}
            onFixPlayers={(n) => {
              setOcrEdited(true);
              const nf = reconcilePositions({ ...form, playersLeft: n });
              setForm(nf);
              const built = buildBoardState(nf);
              if (built.ok && built.state) setState(built.state);
            }}
            gameSel={gameSel}
            modeMismatch={modeMismatch}
            stackRecovered={stackRecovered}
            unresolvedStacks={unresolvedStacks.filter((p) =>
              state.seats.some((s) => s.pos === p && s.stack === 0),
            )}
            onGameModeChange={changeGameSel}
            onReread={ocrReads ? rereadForSelectedMode : undefined}
            modeNote={modeNote}
            onSolve={() => void solve()}
          />
        )}

        {screen === 'result' && state && result && resultRec && (
          <Result
            key={resultRec.id}
            state={state}
            result={result}
            ms={ms}
            record={{ heroAction: resultRec.heroAction, published: false }}
            onSelectAction={(a) => onSelectAction(resultRec, a)}
            onBack={() => setScreen('history')}
          />
        )}

        {screen === 'history' && (
          <RecordsView
            records={records}
            onOpen={openRecord}
            onDelete={(rec) => void onDeleteRecord(rec)}
            onRetry={(rec) => void onRetryRecord(rec)}
            jobRunning={jobRunning}
          />
        )}

        {screen === 'error' && (
          <ErrorView
            issues={issues}
            onManual={() => setManualOpen(true)}
            onRetry={errFromPhoto ? () => setScreen('icm') : undefined}
            imageUrl={ocrImageUrl ?? undefined}
            readout={readout}
            imageSize={imageSize}
            gameSel={errFromPhoto && ocrReads ? gameSel : undefined}
            onGameModeChange={errFromPhoto && ocrReads ? changeGameSel : undefined}
            onReread={errFromPhoto && ocrReads ? rereadForSelectedMode : undefined}
            modeNote={modeNote}
          />
        )}
      </LocalErrorBoundary>

      {manualOpen && (
        <InputForm
          form={form}
          onFormChange={setForm}
          onSubmit={submitManual}
          imageUrl={ocrImageUrl}
          readout={readout}
          imageSize={imageSize}
          onClose={() => setManualOpen(false)}
        />
      )}

      {toast && (
        <Toast
          key={toast.key}
          message={toast.message}
          kind={toast.kind}
          onTap={toast.onTap}
          onClose={() => setToast(null)}
        />
      )}

      {showTabs && (
        <nav className="tabs">
          <button type="button" aria-current={screen === 'icm' ? 'true' : undefined} onClick={() => setScreen('icm')}>
            <span className="ic">♠</span>
            ICM
          </button>
          <button
            type="button"
            aria-current={screen === 'history' ? 'true' : undefined}
            onClick={() => setScreen('history')}
          >
            <span className="ic">▤</span>
            記録
          </button>
        </nav>
      )}
    </div>
  );
}
