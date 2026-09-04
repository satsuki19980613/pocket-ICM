import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import type { BoardState } from '@oshihiki/core';
import { Auth } from './components/Auth';
import { supabase, isConfigured } from './supabase/client';
import { IcmInput } from './components/IcmInput';
import { InputForm } from './components/InputForm';
import { Confirm } from './components/Confirm';
import { Result } from './components/Result';
import { ErrorView } from './components/ErrorView';
import { RecordsView } from './components/RecordsView';
// Drill（訓練）は SPEC §5.6 により一旦 Coming Soon。DrillView 実装はコード上温存（未配線）。
import { ComingSoon } from './components/ComingSoon';
import { Home } from './components/Home';
import { TabBar, type TabKey } from './components/TabBar';
import { Settings } from './components/Settings';
import { Admin } from './components/Admin';
import { buildBoardState, defaultForm, type BoardForm } from './formModel';
import { solveInWorker } from './solverClient';
import type { SolveResultDto } from './solverProtocol';
import { prefillFromScreenshot } from './ocr/screenshotPrefill';
import { buildRecord, type HeroAction, type SpotRecord } from './records/model';
import { SAMPLE_POSTS, type SamplePost } from './data/sampleFeed';
import { deleteRecord, listRecords, putRecord } from './records/store';

type Screen =
  | 'home'
  | 'icm'
  | 'confirm'
  | 'solving'
  | 'result'
  | 'error'
  | 'history'
  | 'drill'
  | 'settings'
  | 'admin';

/** 各画面のヘッダタイトル（モックの titles マップ準拠）。 */
const TITLES: Record<Screen, string> = {
  home: 'Home',
  icm: 'ICM',
  confirm: '条件確認',
  solving: '計算中',
  result: '計算結果',
  error: '条件確認',
  history: '記録',
  drill: 'Training',
  settings: '設定',
  admin: 'クラブ管理',
};

/** 下段タブを出す画面（トップレベル）。フロー中（confirm/solving/result/error/admin）は隠す。 */
const TAB_SCREENS: Screen[] = ['home', 'icm', 'drill', 'history', 'settings'];

/** 画面 → アクティブなタブ（history は「記録」タブ、settings は「設定」タブ）。 */
function tabForScreen(s: Screen): TabKey | null {
  switch (s) {
    case 'home':
      return 'home';
    case 'icm':
      return 'icm';
    case 'drill':
      return 'drill';
    case 'history':
      return 'records';
    case 'settings':
      return 'settings';
    default:
      return null;
  }
}

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
  const [screen, setScreen] = useState<Screen>('home');
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
  // ホームのサンプル投稿を開いた読み取り専用結果（保存 UI なし）。
  const [sampleView, setSampleView] = useState(false);

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
      // ログアウト/削除でセッションが切れたら画面状態を初期化（再ログイン時に home 起点）。
      if (!s) {
        setScreen('home');
        setViewing(null);
      }
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

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

  /** ホームのサンプル投稿を開く → 実ソルバーで解いて読み取り専用結果を表示。 */
  async function openSample(post: SamplePost): Promise<void> {
    const built = buildBoardState(post.form);
    if (!built.ok || !built.state) return; // サンプルは常に妥当
    setViewing(null);
    setSampleView(true);
    setState(built.state);
    setScreen('solving');
    try {
      const { result: dto, ms: elapsed } = await solveInWorker(
        built.state,
        solveOptsForN(built.state.playersLeft),
      );
      setResult(dto);
      setMs(elapsed);
      setScreen('result');
    } catch (e) {
      setErrFromPhoto(false);
      setIssues([e instanceof Error ? e.message : String(e)]);
      setScreen('error');
    }
  }

  async function solve(): Promise<void> {
    if (!state) return;
    setViewing(null); // 新規求解は読み取り専用でない
    setSampleView(false);
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

  /** 下段タブの遷移。 */
  function navTab(key: TabKey): void {
    setViewing(null);
    setSampleView(false);
    switch (key) {
      case 'home':
        setScreen('home');
        break;
      case 'icm':
        setScreen('icm');
        break;
      case 'drill':
        setScreen('drill');
        break;
      case 'records':
        void refreshRecords();
        setScreen('history');
        break;
      case 'settings':
        setScreen('settings');
        break;
    }
  }

  /** フロー画面のヘッダ「戻る」。タブ画面は戻るを出さない。 */
  function backFor(s: Screen): (() => void) | null {
    switch (s) {
      case 'confirm':
      case 'error':
        return () => setScreen('icm');
      case 'admin':
        return () => setScreen('settings');
      case 'result':
        return () => {
          if (viewing) {
            setViewing(null);
            setScreen('history');
          } else {
            setScreen('icm');
          }
        };
      default:
        return null;
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

  const showTabs = TAB_SCREENS.includes(screen);
  const back = backFor(screen);
  const activeTab = tabForScreen(screen);

  return (
    <div className={`app${showTabs ? ' has-tabs' : ''}`}>
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

      {screen === 'home' && <Home posts={SAMPLE_POSTS} onOpen={openSample} />}

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
        sampleView ? (
          <Result
            state={state}
            result={result}
            ms={ms}
            readOnly
            backLabel="ホームに戻る"
            onBack={() => {
              setSampleView(false);
              setScreen('home');
            }}
          />
        ) : viewing ? (
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

      {screen === 'drill' && (
        <ComingSoon
          title="Training"
          body={
            <>
              ランダム出題でオールイン判断を鍛えるモードを準備中です。
              <br />
              5〜6人の即時求解ができ次第、公開します。
            </>
          }
        />
      )}

      {screen === 'settings' && (
        <Settings onBack={() => setScreen('icm')} onOpenAdmin={() => setScreen('admin')} />
      )}

      {screen === 'admin' && <Admin onBack={() => setScreen('settings')} />}

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

      {/* ホームからは FAB で計算へ（モックの ＋→ICM）。 */}
      {screen === 'home' && (
        <button type="button" className="fab" aria-label="計算する" onClick={() => setScreen('icm')}>
          ＋
        </button>
      )}

      {showTabs && activeTab && <TabBar active={activeTab} onNav={navTab} />}
    </div>
  );
}
