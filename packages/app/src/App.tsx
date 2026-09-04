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
import { Home, type FeedState } from './components/Home';
import { Thread } from './components/Thread';
import { UserPub } from './components/UserPub';
import { TabBar, type TabKey } from './components/TabBar';
import { Settings } from './components/Settings';
import { Admin } from './components/Admin';
import { buildBoardState, defaultForm, type BoardForm } from './formModel';
import { solveInWorker } from './solverClient';
import type { SolveResultDto } from './solverProtocol';
import { prefillFromScreenshot } from './ocr/screenshotPrefill';
import {
  buildRecord,
  evLossOf,
  headlineNode,
  type HeroAction,
  type SpotRecord,
} from './records/model';
import { deleteRecord, listRecords, putRecord } from './records/store';
import {
  addComment,
  deleteComment,
  editComment,
  getThread,
  listFeed,
  publishResult,
  setLike,
  uploadThreadImage,
  type FeedAuthor,
  type FeedPost,
  type ThreadDetail,
} from './supabase/feed';

type Screen =
  | 'home'
  | 'thread'
  | 'userpub'
  | 'icm'
  | 'confirm'
  | 'solving'
  | 'result'
  | 'error'
  | 'history'
  | 'drill'
  | 'settings'
  | 'admin';

/**
 * 結果画面の由来。solve=新規求解（保存可）、record=履歴の再表示（読み取り専用）、
 * thread=公開結果の閲覧（読み取り専用・戻るはスレッドへ）。
 */
type ResultOrigin =
  | { kind: 'solve' }
  | { kind: 'record'; rec: SpotRecord }
  | { kind: 'thread'; threadId: string };

/** 各画面のヘッダタイトル（モックの titles マップ準拠）。 */
const TITLES: Record<Screen, string> = {
  home: 'Home',
  thread: 'スレッド',
  userpub: '公開結果',
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

/** 下段タブを出す画面（トップレベル）。フロー中は隠す。 */
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
 * 現状サポートする最大人数。HU/3人/4人は事前計算テーブルで即時・決定的に解ける。
 * 5〜6人は遅い MC＋NN 未統合のため一旦対象外（M8/M9 で開放）。
 */
const MAX_PLAYERS = 4;

const OVER_SCOPE_MSG = `現在は${MAX_PLAYERS}人までの局面に対応しています（5〜6人は準備中）。`;

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
  const [form, setForm] = useState<BoardForm>(() => defaultForm(MAX_PLAYERS));
  const [state, setState] = useState<BoardState | null>(null);
  const [result, setResult] = useState<SolveResultDto | null>(null);
  const [ms, setMs] = useState(0);
  const [issues, setIssues] = useState<string[]>([]);
  // OCR プリフィルの低信頼フィールド（"UTG.stack" 等）。確認画面で強調する。
  const [lowConf, setLowConf] = useState<string[]>([]);
  const [ocrBusy, setOcrBusy] = useState(false);
  // 記録（履歴）: IndexedDB から読み込み。
  const [records, setRecords] = useState<SpotRecord[]>([]);
  // 結果画面の由来（保存可否・戻り先を決める）。
  const [resultOrigin, setResultOrigin] = useState<ResultOrigin>({ kind: 'solve' });

  // --- M6 フィード/スレッド/他人公開 ---
  const [feedState, setFeedState] = useState<FeedState>('loading');
  const [feedPosts, setFeedPosts] = useState<FeedPost[]>([]);
  const [thread, setThread] = useState<ThreadDetail | null>(null);
  const [threadState, setThreadState] = useState<FeedState>('loading');
  const [pubAuthor, setPubAuthor] = useState<FeedAuthor | null>(null);
  const [pubPosts, setPubPosts] = useState<FeedPost[]>([]);
  const [pubState, setPubState] = useState<FeedState>('loading');

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

  // 認証セッションの監視。
  useEffect(() => {
    let active = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (active) setSession(data.session);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
      // ログアウト/削除でセッションが切れたら画面状態を初期化。
      if (!s) {
        setScreen('home');
        setResultOrigin({ kind: 'solve' });
        setThread(null);
      }
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  // ログイン後に一度フィードを読む（起点が home のため）。
  useEffect(() => {
    if (session) void loadFeed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  /** 公開フィードを読み込む。 */
  async function loadFeed(): Promise<void> {
    setFeedState('loading');
    const r = await listFeed();
    if (r.ok) {
      setFeedPosts(r.data);
      setFeedState('ready');
    } else {
      setFeedState('error');
    }
  }

  /** スレッド詳細を開く/再取得。 */
  async function openThread(threadId: string): Promise<void> {
    setScreen('thread');
    setThreadState('loading');
    const r = await getThread(threadId);
    if (r.ok) {
      setThread(r.data);
      setThreadState('ready');
    } else {
      setThread(null);
      setThreadState('error');
    }
  }

  async function refreshThread(): Promise<void> {
    if (!thread) return;
    const r = await getThread(thread.thread_id);
    if (r.ok) setThread(r.data);
  }

  /** スレッドの見出しカード → 公開結果を全結果画面で（読み取り専用）表示。 */
  function openThreadResult(): void {
    if (!thread) return;
    setState(thread.result.spot);
    setResult(thread.result.solution);
    setMs(0);
    setResultOrigin({ kind: 'thread', threadId: thread.thread_id });
    setScreen('result');
  }

  /** 投稿者 → その人の公開結果一覧（userpub）。 */
  async function openAuthor(author: FeedAuthor): Promise<void> {
    setPubAuthor(author);
    setPubState('loading');
    setScreen('userpub');
    const r = await listFeed({ authorId: author.id });
    if (r.ok) {
      setPubPosts(r.data);
      setPubState('ready');
    } else {
      setPubState('error');
    }
  }

  /** ♡ の切替（フィード/スレッド双方を楽観更新し、失敗時は再取得で戻す）。 */
  async function toggleLike(threadId: string, on: boolean): Promise<void> {
    setFeedPosts((ps) =>
      ps.map((p) =>
        p.thread_id === threadId
          ? { ...p, liked_by_me: on, like_count: Math.max(0, p.like_count + (on ? 1 : -1)) }
          : p,
      ),
    );
    setThread((t) =>
      t && t.thread_id === threadId
        ? { ...t, liked_by_me: on, like_count: Math.max(0, t.like_count + (on ? 1 : -1)) }
        : t,
    );
    const r = await setLike(threadId, on);
    if (!r.ok) {
      // 失敗時はサーバ状態に合わせ直す。
      await loadFeed();
      await refreshThread();
    }
  }

  /** 返信（本文＋任意の画像）。画像は先に Storage へ上げて URL 化。 */
  async function onReply(input: { body: string; imageFile: File | null }): Promise<{ ok: boolean; message?: string }> {
    if (!thread) return { ok: false, message: 'スレッドがありません' };
    let imageUrl: string | null = null;
    if (input.imageFile) {
      const up = await uploadThreadImage(input.imageFile);
      if (!up.ok) return { ok: false, message: up.message };
      imageUrl = up.data.url;
    }
    const r = await addComment(thread.thread_id, { body: input.body, imageUrl });
    if (!r.ok) return { ok: false, message: r.message };
    await refreshThread();
    await loadFeed();
    return { ok: true };
  }

  async function onEditComment(commentId: string, body: string): Promise<{ ok: boolean; message?: string }> {
    const r = await editComment(commentId, body);
    if (!r.ok) return { ok: false, message: r.message };
    await refreshThread();
    return { ok: true };
  }

  async function onDeleteComment(commentId: string): Promise<{ ok: boolean; message?: string }> {
    const r = await deleteComment(commentId);
    if (!r.ok) return { ok: false, message: r.message };
    await refreshThread();
    await loadFeed();
    return { ok: true };
  }

  /**
   * 結果画面から記録を保存。published=true なら IndexedDB 保存に加えクラウド公開
   * （results is_public＋threads＋一言コメント）。成否を返す。
   */
  async function onSave(
    heroAction: HeroAction,
    published: boolean,
    comment: string,
  ): Promise<{ ok: boolean; message?: string }> {
    if (!state || !result) return { ok: false, message: '状態がありません' };
    const rec = buildRecord({ state, result, ms, heroAction, published });
    try {
      await putRecord(rec);
      await refreshRecords();
    } catch {
      /* ローカル保存失敗は握りつぶす（オフライン PWA・容量超過等）。 */
    }
    if (published) {
      const head = headlineNode(result);
      const evLoss = head ? evLossOf(head.heroEv, heroAction) : null;
      const pub = await publishResult({ state, result, heroAction, evLoss, comment });
      if (!pub.ok) return { ok: false, message: pub.message };
      await loadFeed();
    }
    return { ok: true };
  }

  async function onDeleteRecord(id: string): Promise<void> {
    await deleteRecord(id).catch(() => {});
    await refreshRecords();
  }

  /** 履歴の1件を読み取り専用で結果画面に再表示。 */
  function openRecord(rec: SpotRecord): void {
    setResultOrigin({ kind: 'record', rec });
    setState(rec.state);
    setResult(rec.result);
    setMs(rec.ms);
    setScreen('result');
  }

  /** 手入力モーダルの確定 → 条件確認へ。無効ならエラー画面。 */
  function submitManual(f: BoardForm): void {
    setManualOpen(false);
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

  /** スクショ添付 → OCR プリフィル → 条件確認。 */
  async function onScreenshot(file: File): Promise<void> {
    setOcrBusy(true);
    setErrFromPhoto(true);
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

  async function solve(): Promise<void> {
    if (!state) return;
    // 念のための防御（入口で弾いているが、5〜6人が届いても遅い MC を走らせない）。
    if (state.playersLeft > MAX_PLAYERS) {
      setErrFromPhoto(false);
      setIssues([OVER_SCOPE_MSG]);
      setScreen('error');
      return;
    }
    setResultOrigin({ kind: 'solve' }); // 新規求解は保存可
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
    setResultOrigin({ kind: 'solve' });
    switch (key) {
      case 'home':
        void loadFeed();
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
      case 'thread':
        return () => setScreen('home');
      case 'userpub':
        return () => setScreen('home');
      case 'result':
        return () => {
          if (resultOrigin.kind === 'record') {
            setScreen('history');
          } else if (resultOrigin.kind === 'thread') {
            setScreen('thread');
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
        <div className="marble" aria-hidden="true" />
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
        <div className="marble" aria-hidden="true" />
        <Auth configured={isConfigured} />
      </div>
    );
  }

  const showTabs = TAB_SCREENS.includes(screen);
  const back = backFor(screen);
  const activeTab = tabForScreen(screen);

  return (
    <div className={`app${showTabs ? ' has-tabs' : ''}`}>
      <div className="marble" aria-hidden="true" />
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

      {screen === 'home' && (
        <Home
          state={feedState}
          posts={feedPosts}
          onOpenThread={(id) => void openThread(id)}
          onOpenAuthor={(a) => void openAuthor(a)}
          onToggleLike={(id, on) => void toggleLike(id, on)}
          onRetry={() => void loadFeed()}
        />
      )}

      {screen === 'thread' &&
        (threadState === 'loading' ? (
          <div className="thread">
            <div className="panel solving">
              <div className="spinner" />
              <p>スレッドを読み込み中…</p>
            </div>
          </div>
        ) : threadState === 'error' || !thread ? (
          <div className="thread">
            <div className="home-empty">
              <p>スレッドを取得できませんでした。</p>
              <button type="button" className="btn ghost" onClick={() => setScreen('home')}>
                ホームに戻る
              </button>
            </div>
          </div>
        ) : (
          <Thread
            detail={thread}
            onOpenResult={openThreadResult}
            onOpenAuthor={(a) => void openAuthor(a)}
            onToggleLike={(on) => void toggleLike(thread.thread_id, on)}
            onReply={onReply}
            onEditComment={onEditComment}
            onDeleteComment={onDeleteComment}
          />
        ))}

      {screen === 'userpub' && (
        <UserPub
          author={pubAuthor}
          state={pubState}
          posts={pubPosts}
          onOpenThread={(id) => void openThread(id)}
          onRetry={() => pubAuthor && void openAuthor(pubAuthor)}
        />
      )}

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

      {screen === 'result' &&
        state &&
        result &&
        (resultOrigin.kind === 'thread' ? (
          <Result
            state={state}
            result={result}
            ms={ms}
            readOnly
            backLabel="スレッドに戻る"
            onBack={() => setScreen('thread')}
          />
        ) : resultOrigin.kind === 'record' ? (
          <Result
            state={state}
            result={result}
            ms={ms}
            readOnly
            savedAction={resultOrigin.rec.heroAction}
            savedEvLoss={resultOrigin.rec.evLoss}
            savedPublished={resultOrigin.rec.published}
            onBack={() => setScreen('history')}
          />
        ) : (
          <Result state={state} result={result} ms={ms} onSave={onSave} onBack={() => setScreen('icm')} />
        ))}

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
