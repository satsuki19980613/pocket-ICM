import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { Session } from '@supabase/supabase-js';
import type { BoardState } from '@oshihiki/core';
import type { OcrReadout } from '@oshihiki/ocr';
import { Auth } from './components/Auth';
import { supabase, isConfigured } from './supabase/client';
import { getMyProfile } from './supabase/profile';
import { IcmInput } from './components/IcmInput';
import { InputForm } from './components/InputForm';
import { Confirm } from './components/Confirm';
import { Result } from './components/Result';
import { ErrorView } from './components/ErrorView';
import { Background } from './components/Background';
import { RecordsView } from './components/RecordsView';
import { Toast } from './components/Toast';
// Training（訓練）タブ。ハブ画面から各機能へ送り出す（SPEC §7.4）。
// AOF ドリル（DrillView）はハブ上で Coming Soon 扱いのまま（実装はコード上温存）。
import { TrainingHub } from './components/TrainingHub';
import { SlumbotView } from './components/SlumbotView';
import { RankingModal } from './components/RankingModal';
import { Home, type FeedState } from './components/Home';
import { Thread } from './components/Thread';
import { UserPub } from './components/UserPub';
import { PostComposer } from './components/PostComposer';
import { TabBar, type TabKey } from './components/TabBar';
import { Settings } from './components/Settings';
import { Admin } from './components/Admin';
import { backLayers } from './backLayers';
import { createBackController } from './navHistory';
import { screenDepth, type Screen } from './navModel';
import { buildBoardState, defaultForm, reconcilePositions, type BoardForm } from './formModel';
import { solveInWorker } from './solverClient';
import type { SolveResultDto } from './solverProtocol';
import { prefillFromScreenshot, type OcrPrefillResult } from './ocr/screenshotPrefill';
import {
  evLossOf,
  finishRecord,
  headlineNode,
  startRecord,
  verdictOf,
  type HeroAction,
  type SpotRecord,
} from './records/model';
import { deleteRecord, listRecords, putRecord } from './records/store';
import {
  IDLE_JOB,
  canStartSolve,
  completeJob,
  createStartLatch,
  failJob,
  startJob,
  type SolveJob,
} from './solveJob';
import {
  abortStaleSolving,
  completeRecord,
  createSolvingRecord,
  deleteMyRecord,
  failRecord,
  findMyRecordIdByClientId,
  listMyRecords,
  publishRecord,
  retryRecord,
  setHeroAction,
  unpublishRecord,
} from './supabase/records';
import { compressForUpload, markImageProtected, uploadSpotImage } from './supabase/images';
import { attachFinalState, diffStates, logOcrRead } from './supabase/ocrLog';
import {
  addComment,
  createPost,
  deleteComment,
  dbToHeroAction,
  deletePost,
  editComment,
  editPost,
  getThread,
  listFeed,
  setLike,
  uploadThreadImage,
  type FeedAuthor,
  type FeedPost,
  type ThreadDetail,
} from './supabase/feed';

// 画面の種類と階層の深さは navModel.ts（端末の戻るの翻訳に使うため App から分離）。

/**
 * 結果画面の由来。record=記録タブ・完了トースト経由の再表示（自分の記録・選択と公開を編集可）、
 * thread=公開結果の閲覧（読み取り専用・戻るはスレッドへ）。
 * v3: 計算は非同期化され、求解直後にその場で結果画面へ遷移する経路（旧 'solve'）は無くなった
 * （SPEC §5.7）。計算完了後は必ず記録タブ経由（トーストタップ or 一覧タップ）で開く。
 */
type ResultOrigin = { kind: 'record'; rec: SpotRecord } | { kind: 'thread'; threadId: string };

/** トースト1件（完了/失敗の通知）。同時に1つだけ（新しいものが古いものを置き換える）。 */
interface ToastState {
  key: number;
  message: string;
  kind: 'done' | 'err';
  onTap: () => void;
}

/** 各画面のヘッダタイトル（モックの titles マップ準拠）。 */
const TITLES: Record<Screen, string> = {
  home: 'Home',
  thread: 'スレッド',
  userpub: '公開結果',
  icm: 'ICM',
  confirm: '条件確認',
  result: '計算結果',
  error: '条件確認',
  history: '記録',
  training: 'Training',
  slumbot: 'Slumbot HU',
  settings: '設定',
  admin: 'クラブ管理',
};

/** 下段タブを出す画面（トップレベル）。フロー中は隠す。 */
const TAB_SCREENS: Screen[] = ['home', 'icm', 'training', 'history', 'settings'];

/** 画面 → アクティブなタブ（history は「記録」タブ、settings は「設定」タブ）。 */
function tabForScreen(s: Screen): TabKey | null {
  switch (s) {
    case 'home':
      return 'home';
    case 'icm':
      return 'icm';
    case 'training':
    case 'slumbot':
      return 'training';
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
 * 5〜6人も直接求解で対応（数秒〜十数秒）。
 */
const MAX_PLAYERS = 6;

/** 手入力フォームの既定人数（さつき決定：既定は4人のまま据え置き。アンティ all 0.25 標準）。 */
const DEFAULT_PLAYERS = 4;

const OVER_SCOPE_MSG = `現在は${MAX_PLAYERS}人までの局面に対応しています。`;

/**
 * 人数に応じた求解パラメータ。ショーダウン MC は Web Worker 並列（mcPool）なので
 * 反復・サンプルを厚めに取れる。3人以上の同時オールインは層化 MC のため反復を厚く
 * 取れる（exploitability がしきい値に達すれば早期終了する）。
 * solver.worker.ts が 2人・3人ショーダウンを厳密化する win/tie テーブルに加え、
 * 3人ショーダウンも wintie3 テーブル（約21MB）で厳密化するため、早期停止しきい値は
 * MC ノイズ床を前提にした従来値より自動的に狭まる（nwaySolver.ts の targetExploitabilityPt
 * 既定式: winTie3 指定時は poolPt×0.0002、未指定時は poolPt×0.0015）。
 */
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

/**
 * スクショ1枚に対する OCR 実行＋サーバ記録（画像アップロード・OCR ログ）をまとめて行う
 * （SPEC §5.7 の A: スクショ投入時）。アップロード・ログの失敗はアプリを止めない
 * （imageId/ocrReadId は未設定のまま呼び出し側へ返し、以降もローカルだけで計算は続けられる）。
 * OCR が読めなかった画像は精度改善の資産として無期限保持に切り替える
 * （markImageProtected, §7.2/§12）。
 */
async function runOcrAndLog(
  file: File,
): Promise<{ res: OcrPrefillResult; imageId?: string; ocrReadId?: string }> {
  let imageId: string | undefined;
  try {
    const { blob, width, height } = await compressForUpload(file);
    const up = await uploadSpotImage(blob, { width, height });
    if (up.ok) imageId = up.data.imageId;
  } catch {
    /* 圧縮/アップロード失敗はアプリを止めない（§7.2）。imageId は未設定のまま進む。 */
  }

  const res = await prefillFromScreenshot(file);

  let ocrReadId: string | undefined;
  try {
    const built = res.ok && res.form ? buildBoardState(res.form) : null;
    const w = res.imageSize?.w ?? 0;
    const h = res.imageSize?.h ?? 0;
    const log = await logOcrRead({
      imageId,
      ok: res.ok,
      displayMode: res.readout?.displayMode,
      street: res.readout?.street.value,
      issues: res.issues,
      issueCodes: res.issueCodes ?? [],
      lowConfidence: res.lowConfidenceFields,
      rawReads: res.readout,
      state: built?.ok ? (built.state ?? null) : null,
      device: {
        ua: navigator.userAgent,
        dpr: window.devicePixelRatio || 1,
        w,
        h,
        aspect: h ? w / h : 0,
      },
    });
    if (log.ok) ocrReadId = log.data.id;
  } catch {
    /* OCR ログの失敗もアプリを止めない（成功・失敗を問わず記録したいが、書けなければ諦める）。 */
  }

  // OCR が読めなかった画像は無期限保持へ（精度改善の資産, §7.2/§12）。
  if (!res.ok && imageId) {
    await markImageProtected(imageId).catch(() => undefined);
  }

  return { res, imageId, ocrReadId };
}

export function App(): JSX.Element {
  // 認証セッション。undefined=判定中（初期ロード）, null=未ログイン, Session=ログイン済み。
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [screen, setScreen] = useState<Screen>('home');
  // 手入力モーダル（写真起点・確認の修正・エラーの手埋めから開く）。
  const [manualOpen, setManualOpen] = useState(false);
  // エラーが写真経路由来か（「別の写真を選ぶ」を出すか）。
  const [errFromPhoto, setErrFromPhoto] = useState(false);
  const [form, setForm] = useState<BoardForm>(() => defaultForm(DEFAULT_PLAYERS));
  const [state, setState] = useState<BoardState | null>(null);
  const [result, setResult] = useState<SolveResultDto | null>(null);
  const [ms, setMs] = useState(0);
  const [issues, setIssues] = useState<string[]>([]);
  // OCR プリフィルの低信頼フィールド（"UTG.stack" 等）。確認画面で強調する。
  const [lowConf, setLowConf] = useState<string[]>([]);
  const [ocrBusy, setOcrBusy] = useState(false);
  // OCR で読み取った元画像（objectURL）。写真経由のときだけ保持し、確認/修正/エラー画面で
  // 「元画像を確認」から照合できるようにする。手入力・リセットで破棄。
  const [ocrImageUrl, setOcrImageUrl] = useState<string | null>(null);
  // OCR 出力（元画像 × OCR 結果の照合ビュー用, SPEC §5.2.3）。写真経由のときだけ持つ。
  const [readout, setReadout] = useState<OcrReadout | undefined>(undefined);
  const [imageSize, setImageSize] = useState<{ w: number; h: number } | undefined>(undefined);
  // OCR 直後（利用者が確認画面で直す前）の BoardState。solve() 実行時に diffStates の基準として
  // 使う（§12.1: 利用者が直した差分＝暗黙の正解ラベル）。手入力のみのときは null のまま。
  const [ocrOriginalState, setOcrOriginalState] = useState<BoardState | null>(null);
  // スクショ由来の画像/OCR 読み取りログの id（solve() 実行時に results 行へ紐付ける）。
  const [pendingImageId, setPendingImageId] = useState<string | undefined>(undefined);
  const [pendingOcrReadId, setPendingOcrReadId] = useState<string | undefined>(undefined);
  // 記録（履歴）: サーバが正・IndexedDB はキャッシュ（§9.3/§9.4）。
  const [records, setRecords] = useState<SpotRecord[]>([]);
  // 結果画面の由来（読み取り専用/編集可・戻り先を決める）。
  const [resultOrigin, setResultOrigin] = useState<ResultOrigin | null>(null);
  // 計算ジョブ。App のトップレベル state で持つことで、画面遷移（コンポーネントの
  // アンマウント）で消えない（SPEC §5.7 の2・6: 計算中も他タブを自由に操作できる）。
  const [solveJob, setSolveJob] = useState<SolveJob>(IDLE_JOB);
  // solve()/onRetryRecord() の連打対策（同期ラッチ, Task2）。solveJob は state のため
  // 「setSolveJob(startJob(...)) が実際に反映されるまで（createSolvingRecord の await 後）」
  // の間は running を観測できない。その隙間を塞ぐため、state を介さない同期フラグで
  // クリック入口から即座に二重起動を弾く。計算が終わる（成功/失敗どちらでも）まで保持し、
  // 必ず try/finally で解除する（解除漏れ＝永久に計算できなくなる最悪のバグ）。
  const startingRef = useRef(createStartLatch());
  // 完了/失敗トースト（同時に1つ）。
  const [toast, setToast] = useState<ToastState | null>(null);
  // 再送（resyncPending）の多重起動ガード。refreshRecords から呼ぶため再入しうる。
  const resyncing = useRef(false);
  // 設定「計算したら最初から公開する」（profiles.default_public）。結果画面の公開レバーの
  // 初期状態に使う（SPEC §5.3。オンでも「この内容で公開する」を押すまで公開はされない）。
  const [defaultPublish, setDefaultPublish] = useState(false);

  // --- M6 フィード/スレッド/他人公開 ---
  const [feedState, setFeedState] = useState<FeedState>('loading');
  const [feedPosts, setFeedPosts] = useState<FeedPost[]>([]);
  const [thread, setThread] = useState<ThreadDetail | null>(null);
  const [threadState, setThreadState] = useState<FeedState>('loading');
  const [pubAuthor, setPubAuthor] = useState<FeedAuthor | null>(null);
  const [pubPosts, setPubPosts] = useState<FeedPost[]>([]);
  const [pubState, setPubState] = useState<FeedState>('loading');
  // 公開結果一覧をどこから開いたか（戻り先。ホーム経由とスレッド経由で階層が変わる）。
  const [pubFrom, setPubFrom] = useState<Screen>('home');
  // 通常投稿コンポーザ（v3・ホームの FAB から開く。計算は ICM タブに一本化, SPEC §5.1.2）。
  const [composerOpen, setComposerOpen] = useState(false);
  // ランキング（Training 系画面のヘッダ右上 ▲）。画面遷移にすると対局中のハンドが
  // 消えるので、重なりとして開く（端末の戻るで閉じるのは backLayers が面倒を見る）。
  const [rankingOpen, setRankingOpen] = useState(false);

  /**
   * 記録タブの再取得（SPEC §9.4）。まずローカルキャッシュを描き、サーバ取得が済み次第
   * 差し替える。ただしオフライン等でまだサーバに届いていない記録（pendingSync）は
   * 消さない＝ユーザーの計算結果を絶対に失わない（冒頭の守ること）。
   */
  async function refreshRecords(): Promise<void> {
    let local: SpotRecord[] = [];
    try {
      local = await listRecords();
      setRecords(local);
    } catch {
      /* IndexedDB 不可の環境では履歴は空のまま（機能縮退）。 */
    }
    const remote = await listMyRecords();
    if (remote.ok) {
      const pendingOnly = local.filter(
        (r) => r.pendingSync && !remote.data.some((s) => s.clientId === r.clientId),
      );
      // サーバ反映が未完（solving/aborted のまま）でも、ローカルに完了済みの結果があるなら
      // そちらを見せる。完了した計算が「中断されました」に化けて見えるのを防ぐ。
      const byClient = new Map(local.map((r) => [r.clientId, r]));
      const merged = remote.data.map((r) => {
        const l = byClient.get(r.clientId);
        return l && l.status === 'done' && r.status !== 'done' ? { ...l, serverId: r.serverId } : r;
      });
      setRecords([...pendingOnly, ...merged]);
      // サーバに届いていない記録があれば、この機会（＝オンラインが確認できた今）に再送する。
      if (pendingOnly.length > 0) void resyncPending(pendingOnly);
    }
  }

  /**
   * オフライン等でサーバへ届かなかった記録の再送（SPEC §9.4）。
   * `client_id` が冪等キーなので二重登録は起きない（挿入が一意制約で弾かれたら
   * 既存行の id を引き直して続きの更新だけ行う）。再送に失敗したものは pendingSync の
   * まま残し、次に記録タブを開いたときにまた試す。
   */
  async function resyncPending(pending: readonly SpotRecord[]): Promise<void> {
    if (resyncing.current || pending.length === 0) return;
    resyncing.current = true;
    let changed = false;
    try {
      for (const rec of pending) {
        let serverId = rec.serverId;
        if (!serverId) {
          const created = await createSolvingRecord({
            clientId: rec.clientId,
            spot: rec.state,
            imageId: rec.imageId,
            ocrReadId: rec.ocrReadId,
            heroHand: rec.heroHand,
            heroPos: rec.heroPos,
            playersLeft: rec.playersLeft,
          });
          if (created.ok) {
            serverId = created.data.id;
          } else {
            // 一意制約で弾かれた＝既にサーバにある可能性。id を引き直す。
            const found = await findMyRecordIdByClientId(rec.clientId);
            if (found.ok && found.data.id) serverId = found.data.id;
          }
        }
        if (!serverId) continue; // まだ届かない（オフライン）。次回に委ねる。

        if (rec.status === 'done' && rec.result) {
          const head = headlineNode(rec.result);
          const done = await completeRecord(serverId, {
            solution: rec.result,
            ms: rec.ms,
            verdict: head ? verdictOf(head) : 'FOLD',
            heroEv: head?.heroEv ?? 0,
          });
          if (!done.ok) continue;
          if (rec.heroAction) {
            await setHeroAction(serverId, rec.heroAction, rec.evLoss).catch(() => undefined);
          }
        } else if (rec.status === 'failed') {
          const f = await failRecord(serverId, rec.error ?? '計算に失敗しました');
          if (!f.ok) continue;
        }
        // status が solving/aborted のものは serverId を結び直すだけ。中断は次回ログイン時の
        // abortStaleSolving がサーバ側の状態を揃える。
        try {
          await putRecord({ ...rec, serverId, pendingSync: false });
        } catch {
          /* IndexedDB 不可でも再送自体は成立している。 */
        }
        changed = true;
      }
    } finally {
      resyncing.current = false;
    }
    if (changed) await refreshRecords();
  }

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
        setResultOrigin(null);
        setThread(null);
        setSolveJob(IDLE_JOB);
        setToast(null);
      }
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  // ログイン後: 未送信の記録を先に再送 → 中断掃除 → 記録読み込み。フィードも読む（起点が home）。
  useEffect(() => {
    if (!session) return;
    void (async () => {
      // 再送を先に行う。順序が逆だと「ローカルでは完了しているがサーバ未反映」の記録を
      // abortStaleSolving が中断へ落としてしまい、完了済みの結果が中断表示に化ける。
      try {
        const local = await listRecords();
        await resyncPending(local.filter((r) => r.pendingSync));
      } catch {
        /* IndexedDB 不可なら再送するものも無い。 */
      }
      // 起動時、solving のまま残っている自分の記録を中断に落とす（§5.7 の5）。
      await abortStaleSolving().catch(() => undefined);
      await refreshRecords();
      const prof = await getMyProfile();
      if (prof.ok) setDefaultPublish(prof.data.default_public);
    })();
    void loadFeed();
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

  /**
   * スレッドの見出しカード → 公開結果を全結果画面で（読み取り専用）表示。
   * 結果投稿のときだけ意味を持つ（通常投稿は結果を持たないため何もしない, v3）。
   */
  function openThreadResult(): void {
    if (!thread || thread.kind !== 'result' || !thread.result) return;
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
    // 一覧の中でさらに別の投稿者を開いても、最初の入口（ホーム/スレッド）を戻り先に保つ。
    if (screen !== 'userpub') setPubFrom(screen);
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

  /** 自分の通常投稿の本文を編集（SPEC §5.1.2）。 */
  async function onEditPost(body: string): Promise<{ ok: boolean; message?: string }> {
    if (!thread) return { ok: false, message: 'スレッドがありません' };
    const r = await editPost(thread.thread_id, body);
    if (!r.ok) return { ok: false, message: r.message };
    await refreshThread();
    await loadFeed();
    return { ok: true };
  }

  /** 自分の通常投稿を削除（返信ごと消える）。削除したらホームへ戻る（SPEC §5.1.2）。 */
  async function onDeletePost(): Promise<{ ok: boolean; message?: string }> {
    if (!thread) return { ok: false, message: 'スレッドがありません' };
    const r = await deletePost(thread.thread_id);
    if (!r.ok) return { ok: false, message: r.message };
    setThread(null);
    setScreen('home');
    await loadFeed();
    return { ok: true };
  }

  /**
   * 通常投稿の作成（v3・SPEC §5.1.2）。成功したらフィードを再取得し、既存の Toast の仕組みで
   * 「投稿しました」を出す（タップで自分のスレッドへ）。PostComposer は成功を受けて自ら閉じる。
   */
  async function onCreatePost(input: {
    body: string;
    imageFile: File | null;
  }): Promise<{ ok: boolean; message?: string }> {
    const r = await createPost(input);
    if (!r.ok) return { ok: false, message: r.message };
    await loadFeed();
    const threadId = r.data.thread_id;
    showToast('投稿しました', 'done', () => void openThread(threadId));
    return { ok: true };
  }

  /** 完了/失敗トーストを出す（同時に1つ。新しいものが古いものを置き換える, SPEC §5.7 の4）。 */
  function showToast(message: string, kind: 'done' | 'err', onTap: () => void): void {
    setToast({ key: Date.now(), message, kind, onTap });
  }

  /** 自分の選択（ALL IN/FOLD/未選択）を保存（SPEC §5.3、押した時点で確定・任意）。 */
  async function onSelectAction(
    rec: SpotRecord,
    action: HeroAction | null,
  ): Promise<{ ok: boolean; message?: string }> {
    const head = rec.result ? headlineNode(rec.result) : null;
    const evLoss = action != null && head ? evLossOf(head.heroEv, action) : null;
    if (rec.serverId) {
      const r = await setHeroAction(rec.serverId, action, evLoss);
      if (!r.ok) return { ok: false, message: r.message };
    }
    const updated: SpotRecord = { ...rec, heroAction: action, evLoss };
    try {
      await putRecord(updated);
    } catch {
      /* ローカル保存失敗は握りつぶす（サーバは更新済み）。 */
    }
    await refreshRecords();
    return { ok: true };
  }

  /**
   * 公開レバー（SPEC §5.3）。on=true で `publishRecord`（is_public 更新＋スレッド作成、
   * 公開時の一言は `threads.body` に保存）、on=false で `unpublishRecord`（スレッド削除＋
   * is_public を戻す）。
   * v2 にあった `supabase/feed.ts` の `publishResult`（計算結果を新規 results 行として
   * 公開する経路）は WP-D で削除済み（既に呼び出し元が無いことを確認して削除）。
   */
  async function onTogglePublish(
    rec: SpotRecord,
    on: boolean,
    comment: string,
  ): Promise<{ ok: boolean; message?: string }> {
    if (!rec.serverId) {
      return { ok: false, message: 'サーバへの同期待ちのため、まだ公開できません（少し待って再度お試しください）' };
    }
    if (on) {
      const r = await publishRecord(rec.serverId, comment);
      if (!r.ok) return { ok: false, message: r.message };
    } else {
      const r = await unpublishRecord(rec.serverId);
      if (!r.ok) return { ok: false, message: r.message };
    }
    const updated: SpotRecord = { ...rec, published: on };
    try {
      await putRecord(updated);
    } catch {
      /* ローカル保存失敗は握りつぶす（サーバは更新済み）。 */
    }
    await refreshRecords();
    await loadFeed(); // 公開/取消はホームフィードにも反映する。
    return { ok: true };
  }

  /** 記録の削除（サーバ→ローカルの順, SPEC §5.4）。 */
  async function onDeleteRecord(rec: SpotRecord): Promise<void> {
    if (rec.serverId) {
      await deleteMyRecord(rec.serverId).catch(() => undefined);
    }
    await deleteRecord(rec.id).catch(() => undefined);
    await refreshRecords();
  }

  /** 履歴の1件を結果画面に表示（自分の記録＝選択・公開を編集できる, SPEC §5.3/§5.4）。 */
  function openRecord(rec: SpotRecord): void {
    if (rec.status !== 'done' || !rec.result) return; // 計算中/失敗はタップしても開かない。
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

  /** OCR 元画像を差し替え（前のは revoke）。null で破棄。 */
  function setOcrImage(url: string | null): void {
    setOcrImageUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return url;
    });
  }

  /** スクショ由来の画像/OCR 参照を一発分クリアする（次のスポットへ持ち越さない）。 */
  function clearOcrPending(): void {
    setPendingImageId(undefined);
    setPendingOcrReadId(undefined);
    setOcrOriginalState(null);
  }

  /** icm タブの「手入力する」（写真なしの新規入力）。前回スクショの文脈を持ち越さない。 */
  function startFreshManual(): void {
    setOcrImage(null);
    setReadout(undefined);
    setImageSize(undefined);
    clearOcrPending();
    setManualOpen(true);
  }

  /** スクショ添付 → 画像アップロード＋OCR ログ → OCR プリフィル → 条件確認。 */
  async function onScreenshot(file: File): Promise<void> {
    setOcrBusy(true);
    setErrFromPhoto(true);
    setOcrImage(URL.createObjectURL(file));
    setReadout(undefined);
    setImageSize(undefined);
    clearOcrPending();
    try {
      const { res, imageId, ocrReadId } = await runOcrAndLog(file);
      setReadout(res.readout);
      setImageSize(res.imageSize);
      setPendingImageId(imageId);
      setPendingOcrReadId(ocrReadId);

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
      setOcrOriginalState(built.state);
      setState(built.state);
      setScreen('confirm');
    } catch (e) {
      setIssues(['スクリーンショットの読み込みに失敗しました。', e instanceof Error ? e.message : String(e)]);
      setScreen('error');
    } finally {
      setOcrBusy(false);
    }
  }

  /**
   * Web Worker で実際に解く（新規計算・再計算の共通経路）。完了/失敗どちらでもローカル
   * （IndexedDB）とサーバ（`completeRecord`/`failRecord`）を更新し、トーストを出す。
   * `rec`/`finalState`/`serverId` を引数で受け取ることで、画面が別タブへ切り替わっても
   * （このクロージャは App の1つのメソッド呼び出しの中で完結するため）計算が止まらない。
   */
  async function runSolve(rec: SpotRecord, finalState: BoardState, serverId: string | undefined): Promise<void> {
    try {
      const { result: dto, ms: elapsed } = await solveInWorker(finalState, solveOptsForN(finalState.playersLeft));
      const finished = finishRecord(rec, { result: dto, ms: elapsed });
      try {
        await putRecord(finished);
      } catch {
        /* ローカル保存失敗は握りつぶす（サーバ側は下で更新を試みる）。 */
      }
      await refreshRecords();
      setSolveJob((j) => (j.recordId === rec.id ? completeJob(j) : j));
      showToast('計算が完了しました', 'done', () => openRecord(finished));

      if (serverId) {
        const head = headlineNode(dto);
        const verdict = head ? verdictOf(head) : 'FOLD';
        const heroEv = head?.heroEv ?? 0;
        const comp = await completeRecord(serverId, { solution: dto, ms: elapsed, verdict, heroEv });
        if (!comp.ok) {
          // サーバ反映に失敗しても計算結果はローカルに残す（pendingSync を立てて次回に委ねる）。
          const pending: SpotRecord = { ...finished, pendingSync: true };
          try {
            await putRecord(pending);
          } catch {
            /* noop */
          }
          await refreshRecords();
        }
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const failed: SpotRecord = { ...rec, status: 'failed', error: message };
      try {
        await putRecord(failed);
      } catch {
        /* noop */
      }
      await refreshRecords();
      setSolveJob((j) => (j.recordId === rec.id ? failJob(j) : j));
      showToast('計算に失敗しました', 'err', () => setScreen('history'));
      if (serverId) {
        await failRecord(serverId, message).catch(() => undefined);
      }
    }
  }

  /**
   * 「この内容で計算する」（SPEC §5.7）。solving 画面は廃止。記録を1件作って記録タブへ
   * 遷移し、計算は Worker でバックグラウンド継続する（ジョブは App のトップレベル state
   * のため、画面遷移で消えない）。
   */
  async function solve(): Promise<void> {
    if (!state) return;
    if (!canStartSolve(solveJob)) return; // 同時1件の制約（IcmInput 側でも弾くが二重防御）。
    if (!startingRef.current.acquire()) return; // 連打対策の同期ラッチ（Task2）。取れなければ即終了。
    let started = false; // true になったら runSolve 側の finally が解除を引き継ぐ。
    try {
      // 念のための防御（入口で弾いているが、7人以上が届いても求解しない）。
      if (state.playersLeft > MAX_PLAYERS) {
        setErrFromPhoto(false);
        setIssues([OVER_SCOPE_MSG]);
        setScreen('error');
        return;
      }

      const finalState = state;
      const clientId = crypto.randomUUID();
      const imageId = pendingImageId;
      const ocrReadId = pendingOcrReadId;
      const originalState = ocrOriginalState;
      clearOcrPending(); // 一発勝負（このスポット限り）。次のスポットへ持ち越さない。

      // OCR 由来なら、利用者が確認画面で直した差分を正解ラベルとして残す（§12.1）。
      if (ocrReadId && originalState) {
        void attachFinalState(ocrReadId, finalState, diffStates(originalState, finalState)).catch(() => undefined);
      }

      const localRec = startRecord({
        clientId,
        state: finalState,
        heroHand: finalState.heroHand,
        heroPos: finalState.heroPos,
        playersLeft: finalState.playersLeft,
        imageId,
        ocrReadId,
      });

      const created = await createSolvingRecord({
        clientId,
        spot: finalState,
        imageId,
        ocrReadId,
        heroHand: finalState.heroHand,
        heroPos: finalState.heroPos,
        playersLeft: finalState.playersLeft,
      });
      const serverId = created.ok ? created.data.id : undefined;
      const rec: SpotRecord = { ...localRec, serverId, pendingSync: !created.ok };

      try {
        await putRecord(rec);
      } catch {
        /* IndexedDB 不可の環境でも続行（サーバに残っていれば記録は失われない）。 */
      }
      await refreshRecords();

      setSolveJob(startJob(rec.id));
      setScreen('history'); // solving 画面は廃止。記録タブへ遷移し先頭に「計算中」を出す。

      started = true;
      void runSolve(rec, finalState, serverId).finally(() => startingRef.current.release());
    } finally {
      if (!started) startingRef.current.release(); // 早期 return・例外時はここで解除する。
    }
  }

  /** 記録タブの「再計算」（失敗/中断した記録を解き直す, SPEC §5.4）。 */
  async function onRetryRecord(rec: SpotRecord): Promise<void> {
    if (!canStartSolve(solveJob)) return; // 同時1件の制約。
    if (!startingRef.current.acquire()) return; // 連打対策の同期ラッチ（Task2）。取れなければ即終了。
    let started = false; // true になったら runSolve 側の finally が解除を引き継ぐ。
    try {
      if (rec.serverId) {
        await retryRecord(rec.serverId).catch(() => undefined);
      }
      const restarted: SpotRecord = { ...rec, status: 'solving', error: undefined, result: null };
      try {
        await putRecord(restarted);
      } catch {
        /* noop */
      }
      await refreshRecords();
      setSolveJob(startJob(restarted.id));
      started = true;
      void runSolve(restarted, restarted.state, rec.serverId).finally(() => startingRef.current.release());
    } finally {
      if (!started) startingRef.current.release(); // 早期 return・例外時はここで解除する。
    }
  }

  /** 下段タブの遷移。 */
  function navTab(key: TabKey): void {
    switch (key) {
      case 'home':
        void loadFeed();
        setScreen('home');
        break;
      case 'icm':
        setScreen('icm');
        break;
      case 'training':
        setScreen('training');
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
      case 'slumbot':
        return () => setScreen('training');
      case 'thread':
        return () => setScreen('home');
      case 'userpub':
        // 入口へ戻す（スレッドから開いたのにホームへ飛ばされる、を防ぐ）。
        return () => setScreen(pubFrom === 'thread' && thread ? 'thread' : 'home');
      case 'result':
        return () => {
          if (resultOrigin?.kind === 'thread') {
            setScreen('thread');
          } else {
            setScreen('history');
          }
        };
      default:
        return null;
    }
  }

  /**
   * 端末の「戻る」1回ぶん。上に重なっているモーダルから順に閉じ、無ければ画面を1階層戻す。
   * ルートのタブ画面（ホーム）まで戻ったら何もしない＝次の戻るでアプリ終了（Android 標準）。
   */
  function stepBack(): void {
    if (backLayers.closeTop()) return;
    const b = backFor(screen);
    if (b) {
      b();
      return;
    }
    if (screen !== 'home') navTab('home'); // タブ画面 → ホーム（起点）へ。
  }

  // popstate は最新の stepBack を呼ぶ必要があるが、リスナは張り直したくないので ref 経由。
  const stepBackRef = useRef(stepBack);
  stepBackRef.current = stepBack;

  // アプリ内の階層の深さ。これと同じ数だけ履歴にダミーを積む（navHistory.ts）。
  const layerCount = useSyncExternalStore(
    backLayers.subscribe,
    backLayers.getCount,
    backLayers.getCount,
  );
  const navDepth = session
    ? screenDepth(screen, { pubFromThread: pubFrom === 'thread' }) + layerCount
    : 0; // 未ログイン（認証画面）は常にルート。

  // 端末の戻る（popstate）と Esc を購読する。Esc は最前面の重なりだけを閉じる
  // （各モーダルが個別に window を購読すると、入れ子のとき同時に閉じてしまう）。
  const backCtl = useRef<ReturnType<typeof createBackController> | null>(null);
  useEffect(() => {
    const ctl = createBackController(window.history);
    backCtl.current = ctl;
    const onPop = (): void => {
      if (ctl.handlePop()) stepBackRef.current();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && backLayers.closeTop()) e.preventDefault();
    };
    window.addEventListener('popstate', onPop);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('keydown', onKey);
      backCtl.current = null;
    };
  }, []);

  // 深さが変わるたびに履歴を追従させる（深くなれば push、浅くなれば戻す）。
  useEffect(() => {
    backCtl.current?.sync(navDepth);
  }, [navDepth]);

  // セッション判定中は最小のローディング（チラつき防止）。
  if (session === undefined) {
    return (
      <div className="app">
        <Background />
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
        <Background />
        <Auth configured={isConfigured} />
      </div>
    );
  }

  const showTabs = TAB_SCREENS.includes(screen);
  const back = backFor(screen);
  const activeTab = tabForScreen(screen);
  const jobRunning = solveJob.status === 'running';
  // ランキングは Training 系の画面だけ。ヘッダ左右の幅をそろえてタイトルを中央に保つ。
  const showRanking = screen === 'training' || screen === 'slumbot';

  return (
    <div className={`app${showTabs ? ' has-tabs' : ''}`}>
      <Background />
      <header className={`topbar${showRanking ? ' has-rank' : ''}`}>
        {back ? (
          <button type="button" className="tb-back" aria-label="戻る" onClick={back}>
            ‹
          </button>
        ) : (
          <span className="tb-sp" />
        )}
        <h1 className="tb-title">{TITLES[screen]}</h1>
        {showRanking ? (
          <button type="button" className="tb-rank" onClick={() => setRankingOpen(true)}>
            <span className="tb-rank-ic">▲</span>
            RANKING
          </button>
        ) : (
          <span className="tb-sp" />
        )}
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
            onEditPost={onEditPost}
            onDeletePost={onDeletePost}
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
        <IcmInput
          onScreenshot={onScreenshot}
          onManual={startFreshManual}
          ocrBusy={ocrBusy}
          blocked={jobRunning}
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
            // 安全網: 写真取り込みで席を1つ取りこぼす（スタック未読=空席扱い）と人数が
            // 少なく出る。確認画面で人数を選び直すと reconcilePositions が席を補い、
            // 誤った人数のまま黙って解くのを防ぐ（補った席のスタックは下で要確認）。
            const nf = reconcilePositions({ ...form, playersLeft: n });
            setForm(nf);
            const built = buildBoardState(nf);
            if (built.ok && built.state) setState(built.state);
          }}
          onSolve={solve}
        />
      )}

      {screen === 'result' &&
        state &&
        result &&
        resultOrigin &&
        (resultOrigin.kind === 'thread' ? (
          <Result
            state={state}
            result={result}
            ms={ms}
            readOnly
            backLabel="スレッドに戻る"
            savedAction={dbToHeroAction(thread?.result?.hero_action ?? null)}
            savedEvLoss={thread?.result?.ev_loss ?? null}
            savedPublished
            onBack={() => setScreen('thread')}
          />
        ) : (
          <Result
            state={state}
            result={result}
            ms={ms}
            record={{ heroAction: resultOrigin.rec.heroAction, published: resultOrigin.rec.published }}
            defaultPublish={defaultPublish}
            onSelectAction={(a) => onSelectAction(resultOrigin.rec, a)}
            onTogglePublish={(on, comment) => onTogglePublish(resultOrigin.rec, on, comment)}
            onBack={() => setScreen('history')}
          />
        ))}

      {screen === 'history' && (
        <RecordsView
          records={records}
          onOpen={openRecord}
          onDelete={(rec) => void onDeleteRecord(rec)}
          onRetry={(rec) => void onRetryRecord(rec)}
          jobRunning={jobRunning}
        />
      )}

      {screen === 'training' && (
        <TrainingHub onOpenSlumbot={() => setScreen('slumbot')} />
      )}

      {screen === 'slumbot' && <SlumbotView onExit={() => setScreen('training')} />}

      {rankingOpen && <RankingModal onClose={() => setRankingOpen(false)} />}

      {screen === 'settings' && (
        <Settings onBack={() => setScreen('icm')} onOpenAdmin={() => setScreen('admin')} />
      )}

      {screen === 'admin' && <Admin onBack={() => setScreen('settings')} />}

      {screen === 'error' && (
        <ErrorView
          issues={issues}
          onManual={() => setManualOpen(true)}
          onRetry={errFromPhoto ? () => setScreen('icm') : undefined}
          imageUrl={ocrImageUrl ?? undefined}
          readout={readout}
          imageSize={imageSize}
        />
      )}

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

      {/* ホームの FAB は投稿コンポーザへ（v3）。計算は ICM タブから（SPEC §5.1.2）。 */}
      {screen === 'home' && (
        <button type="button" className="fab" aria-label="投稿する" onClick={() => setComposerOpen(true)}>
          ＋
        </button>
      )}

      {composerOpen && <PostComposer onSubmit={onCreatePost} onClose={() => setComposerOpen(false)} />}

      {toast && (
        <Toast
          key={toast.key}
          message={toast.message}
          kind={toast.kind}
          onTap={toast.onTap}
          onClose={() => setToast(null)}
        />
      )}

      {showTabs && activeTab && <TabBar active={activeTab} onNav={navTab} />}
    </div>
  );
}
