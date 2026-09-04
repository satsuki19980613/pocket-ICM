import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import type { BoardState } from '@oshihiki/core';
import { Auth } from './components/Auth';
import { supabase, isConfigured } from './supabase/client';
import { signOut } from './supabase/api';
import { IcmInput } from './components/IcmInput';
import { InputForm } from './components/InputForm';
import { Confirm } from './components/Confirm';
import { Result } from './components/Result';
import { ErrorView } from './components/ErrorView';
import { RecordsView } from './components/RecordsView';
import { DrillView } from './components/DrillView';
import { buildBoardState, defaultForm, type BoardForm } from './formModel';
import { solveInWorker } from './solverClient';
import type { SolveResultDto } from './solverProtocol';
import { prefillFromScreenshot } from './ocr/screenshotPrefill';
import { buildRecord, type HeroAction, type SpotRecord } from './records/model';
import { deleteRecord, listRecords, putRecord } from './records/store';

type Screen = 'icm' | 'confirm' | 'solving' | 'result' | 'error' | 'history' | 'drill';

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
  // 認証セッション。undefined=判定中（初期ロード）, null=未ログイン, Session=ログイン済み。
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [screen, setScreen] = useState<Screen>('icm');
  // 手入力モーダル（写真起点・確認の修正・エラーの手埋めから開く）。
  const [manualOpen, setManualOpen] = useState(false);
  // エラーが写真経路由来か（「別の写真を選ぶ」を出すか）。
  const [errFromPhoto, setErrFromPhoto] = useState(false);
  const [form, setForm] = useState<BoardForm>(() => defaultForm(5));
  const [state, setState] = useState<BoardState | null>(null);
  const [result, setResult] = useState<SolveResultDto | null>(null);
  const [ms, setMs] = useState(0);
  const [issues, setIssues] = useState<string[]>([]);
  // OCR プリフィルの低信頼フィールド（"UTG.stack" 等）。確認画面で強調する。
  const [lowConf, setLowConf] = useState<string[]>([]);
  const [ocrBusy, setOcrBusy] = useState(false);
  // 記録（履歴）: IndexedDB から読み込み。viewing は履歴からの読み取り専用再表示。
  const [records, setRecords] = useState<SpotRecord[]>([]);
  const [viewing, setViewing] = useState<SpotRecord | null>(null);

  async function refreshRecords(): Promise<void> {
    try {
      setRecords(await listRecords());
    } catch {
      /* IndexedDB 不可の環境では履歴は空のまま（機能縮退）。 */
    }
  }

  useEffect(() => {
    void refreshRecords();
  }, []);

  // 認証セッションの監視。起動時に現在のセッションを取得し、以後の変化（ログイン/
  // ログアウト/トークン更新）を購読する。未設定（isConfigured=false）でも getSession は
  // 空セッションを返すので null になり、認証画面が出る。
  useEffect(() => {
    let active = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (active) setSession(data.session);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  async function onLogout(): Promise<void> {
    await signOut();
    // onAuthStateChange が session=null にし、認証画面へ戻る。画面状態は初期化しておく。
    setScreen('icm');
    setViewing(null);
  }

  /** 結果画面から現在の局面を記録する。published=ホーム公開フラグ（既定 false, 反映は M6）。 */
  async function onSave(heroAction: HeroAction, published: boolean): Promise<void> {
    if (!state || !result) return;
    const rec = buildRecord({ state, result, ms, heroAction, published });
    try {
      await putRecord(rec);
      await refreshRecords();
    } catch {
      /* 保存失敗は握りつぶす（オフライン PWA・容量超過等）。UI は「記録しました」を出さない。 */
    }
  }

  async function onDeleteRecord(id: string): Promise<void> {
    await deleteRecord(id).catch(() => {});
    await refreshRecords();
  }

  /** 履歴の1件を読み取り専用で結果画面に再表示。 */
  function openRecord(rec: SpotRecord): void {
    setViewing(rec);
    setState(rec.state);
    setResult(rec.result);
    setMs(rec.ms);
    setScreen('result');
  }

  /** 手入力モーダルの確定 → 条件確認へ。無効ならエラー画面。 */
  function submitManual(f: BoardForm): void {
    setManualOpen(false);
    // 手入力からの遷移は OCR 由来の強調を持ち越さない。
    setLowConf([]);
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

  /**
   * スクショ添付 → OCR プリフィル。成功なら手入力フォームを埋めて条件確認へ
   * （SPEC §6.1: 必ず確認画面を経由し全項目修正可能）。読取失敗・対象外フレームは
   * issues を表示して手入力継続に委ねる。
   */
  async function onScreenshot(file: File): Promise<void> {
    setOcrBusy(true);
    setErrFromPhoto(true); // この経路のエラーは「別の写真を選ぶ」を出す。
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
    setViewing(null); // 新規求解は読み取り専用でない
    setScreen('solving');
    try {
      const { result: dto, ms: elapsed } = await solveInWorker(state, solveOptsForN(state.playersLeft));
      setResult(dto);
      setMs(elapsed);
      setScreen('result');
    } catch (e) {
      setErrFromPhoto(false);
      setIssues([e instanceof Error ? e.message : String(e)]);
      setScreen('error');
    }
  }

  // セッション判定中は最小のローディング（チラつき防止）。
  if (session === undefined) {
    return (
      <div className="app">
        <div className="panel solving">
          <div className="spinner" />
          <p>読み込み中…</p>
        </div>
      </div>
    );
  }

  // 未ログインは認証画面のみ（招待制クラブ＝全機能ログイン必須）。
  if (session === null) {
    return (
      <div className="app">
        <Auth configured={isConfigured} />
      </div>
    );
  }

  return (
    <div className="app">
      <header className="hdr">
        <h1>Black Ops ICM</h1>
        <span className="tag">PUSH / FOLD</span>
        <div className="navgrp">
          <button type="button" className="navrec" onClick={() => setScreen('drill')}>
            訓練
          </button>
          <button
            type="button"
            className="navrec"
            onClick={() => {
              void refreshRecords();
              setScreen('history');
            }}
          >
            記録{records.length > 0 ? ` (${records.length})` : ''}
          </button>
          <button type="button" className="navrec" onClick={() => void onLogout()}>
            ログアウト
          </button>
        </div>
      </header>

      {screen === 'icm' && (
        <IcmInput onScreenshot={onScreenshot} onManual={() => setManualOpen(true)} ocrBusy={ocrBusy} />
      )}

      {screen === 'confirm' && state && (
        <Confirm
          state={state}
          lowConfidenceFields={lowConf}
          onEdit={() => setManualOpen(true)}
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
        viewing ? (
          <Result
            state={state}
            result={result}
            ms={ms}
            readOnly
            savedAction={viewing.heroAction}
            savedEvLoss={viewing.evLoss}
            savedPublished={viewing.published}
            onBack={() => {
              setViewing(null);
              setScreen('history');
            }}
          />
        ) : (
          <Result
            state={state}
            result={result}
            ms={ms}
            onSave={onSave}
            onBack={() => setScreen('icm')}
          />
        )
      )}

      {screen === 'history' && (
        <RecordsView
          records={records}
          onOpen={openRecord}
          onDelete={onDeleteRecord}
          onBack={() => setScreen('icm')}
        />
      )}

      {screen === 'drill' && <DrillView onExit={() => setScreen('icm')} />}

      {screen === 'error' && (
        <ErrorView
          issues={issues}
          onManual={() => setManualOpen(true)}
          onRetry={errFromPhoto ? () => setScreen('icm') : undefined}
        />
      )}

      {manualOpen && (
        <InputForm
          form={form}
          onFormChange={setForm}
          onSubmit={submitManual}
          onClose={() => setManualOpen(false)}
        />
      )}

      <footer className="ft">
        端末ローカル完結・RTA なし。数値は実払い pt。求解は端末内（Web Worker）。
      </footer>
    </div>
  );
}
