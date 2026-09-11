import { useSyncExternalStore } from 'react';
import { registerSW } from 'virtual:pwa-register';

import { shouldAutoApply, type UpdateTrigger } from './updatePolicy';

/**
 * アプリの更新（新しい版の配信）を拾って入れ替える仕組み。
 *
 * 背景: PWA は Service Worker が前の版をキャッシュから出すので、デプロイしても開き直すまで
 * 古い画面のままだった（Android の PWA は裏に残るので、開き直したつもりでも古い版が続く）。
 * そこで SW を prompt 方式にし（vite.config.ts）、新しい版が待機に入ったら、いつ入れ替えるかを
 * ここで決める。判定そのものは updatePolicy.ts の純関数。
 *
 * - 起動時: 更新を確認し、見つかった版（前回に裏で取得済みのものを含む）は、画面を触る前なら
 *   その場で入れ替えて再読み込みする。
 * - 裏から戻ったとき: 同じく確認し、入力途中・計算中・対局中でなければ自動で入れ替える。
 * - 触っている最中に届いたら、画面上部にお知らせを出す（UpdateBanner）。次に起動・復帰したときに
 *   自動で入る。
 * - 設定の「アップデートを確認」で、その場で確認して入れ替える。
 */

/**
 * 更新の状態。
 * idle=見つかっていない / checking=手動確認中（新しい版のダウンロード中を含む）/ latest=確認した結果最新 /
 * available=新しい版が待機中（自動では入れ替えなかった）/ applying=入れ替え中（まもなく再読み込み）/
 * error=確認に失敗（オフライン等）。
 */
export type UpdatePhase = 'idle' | 'checking' | 'latest' | 'available' | 'applying' | 'error';

export interface AppUpdateState {
  readonly phase: UpdatePhase;
  /** いま動いている版。本番バンドル名のハッシュ部分（開発時は 'dev'）。 */
  readonly version: string;
  /** お知らせを ✕ で閉じた（入れ替えに失敗して戻ったときはまた出す）。 */
  readonly bannerDismissed: boolean;
}

/** 裏から戻ったときに更新を確認する最短間隔（ポーカーチェイスとの行き来のたびに取りに行かない）。 */
const RESUME_CHECK_INTERVAL_MS = 60_000;
/** 手動確認で、新しい版のダウンロードが済むのを待つ上限。 */
const MANUAL_DOWNLOAD_TIMEOUT_MS = 90_000;
/** 入れ替えを頼んでから再読み込みが起きるのを待つ上限。 */
const APPLY_TIMEOUT_MS = 8_000;
/** 支配が新しい版へ移ったのに activated の通知が来ないとき、再読み込みまで待つ時間。 */
const RELOAD_FALLBACK_MS = 1_500;

let state: AppUpdateState = { phase: 'idle', version: 'dev', bannerDismissed: false };
const listeners = new Set<() => void>();

function setState(patch: Partial<AppUpdateState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function getState(): AppUpdateState {
  return state;
}

/** 更新の状態を購読する（設定画面・お知らせ）。 */
export function useAppUpdate(): AppUpdateState {
  return useSyncExternalStore(subscribe, getState);
}

/** 自動入れ替えの判定に使う「いまの契機」。起動時と、裏から戻るたびに作り直す。 */
let trigger: { kind: UpdateTrigger; at: number; touched: boolean } = {
  kind: 'launch',
  at: 0,
  touched: false,
};
let appIdle = false;
let manualRequested = false;
let registration: ServiceWorkerRegistration | undefined;
let updateSW: ((reloadPage?: boolean) => Promise<void>) | undefined;
let lastCheckAt = -Infinity;
let started = false;
/** 起動後（または前回の復帰後）にいったん裏へ回ったか。 */
let wentHidden = false;

/** 起動時に1回だけ呼ぶ（main.tsx・描画より前）。SW を登録し、起動・復帰・操作を見張る。 */
export function initAppUpdate(version: string): void {
  if (started) return;
  started = true;
  setState({ version });
  trigger = { kind: 'launch', at: performance.now(), touched: false };

  window.addEventListener('pointerdown', markTouched, { capture: true, passive: true });
  window.addEventListener('keydown', markTouched, { capture: true });
  document.addEventListener('visibilitychange', onVisibilityChange);

  if (!('serviceWorker' in navigator)) return;
  updateSW = registerSW({
    immediate: true,
    onNeedRefresh: onUpdateWaiting,
    onRegisteredSW(_url, r) {
      registration = r;
      if (r) {
        // 待機入りは registerSW（workbox-window）も知らせるが、登録より前にブラウザが取得を
        // 始めていた版は workbox が見落とすため、自前でも見張る（通知が重なっても害は無い）。
        // 検証では起動時の更新はほぼ毎回こちらの見張りで拾っていた。
        r.addEventListener('updatefound', () => watchInstalling(r));
        watchInstalling(r);
        // workbox が「登録時に待機中か」を見た後、ここまでの間に待機へ入った版は誰も知らせない。
        signalIfWaiting(r);
      }
      // 起動時の確認。画面の読み込みでもブラウザが確認するが、それに頼らず明示的に取りに行く。
      void checkQuietly();
    },
  });
}

/**
 * すでに待機中の版があれば知らせる。待機入りの通知は取りこぼしうる（ブラウザが先に取得を始めて
 * いた・インストールが一瞬で終わった）ので、確認のたびに実物を見る。重なって呼ばれても害は無い。
 */
function signalIfWaiting(r: ServiceWorkerRegistration | undefined): void {
  if (r?.waiting && navigator.serviceWorker.controller) onUpdateWaiting();
}

/** ダウンロード中の新しい版が待機に入ったら知らせる。 */
function watchInstalling(r: ServiceWorkerRegistration): void {
  const sw = r.installing;
  if (!sw) return;
  sw.addEventListener('statechange', () => {
    // 初回インストール（まだ何もページを支配していない）は更新ではない。
    if (sw.state === 'installed' && navigator.serviceWorker.controller) onUpdateWaiting();
  });
}

/** App が描画のたびに「いま再読み込みしても失うものが無いか」を知らせる。 */
export function reportAppIdle(idle: boolean): void {
  appIdle = idle;
}

function markTouched(): void {
  trigger.touched = true;
}

function onVisibilityChange(): void {
  if (document.visibilityState !== 'visible') {
    wentHidden = true;
    return;
  }
  // 裏へ回ってから戻ったときだけを「復帰」とみなす。起動時にブラウザが「見えるようになった」を
  // 知らせることがあり、それを復帰と取り違えると（App がまだ idle を報告していないので）
  // 起動直後の自動入れ替えが止まってしまう。
  if (!wentHidden) return;
  wentHidden = false;
  trigger = { kind: 'resume', at: performance.now(), touched: false };
  if (state.phase === 'available') {
    considerAutoApply();
    return;
  }
  signalIfWaiting(registration);
  if (getState().phase === 'available' || getState().phase === 'applying') return;
  if (performance.now() - lastCheckAt >= RESUME_CHECK_INTERVAL_MS) void checkQuietly();
}

async function checkQuietly(): Promise<void> {
  if (!registration) return;
  lastCheckAt = performance.now();
  try {
    await registration.update();
  } catch {
    // オフライン等。次に起動・復帰したときにまた確認する。
  }
  signalIfWaiting(registration);
}

/** 新しい版のダウンロードが済み、待機に入った（どこから知らされても同じ扱い）。 */
function onUpdateWaiting(): void {
  if (state.phase === 'applying') {
    // 入れ替えを頼んだ時点ではまだ待機に入っていなかった版。待機に入ったので改めて頼む。
    void updateSW?.(true);
    return;
  }
  setState({ phase: 'available' });
  considerAutoApply();
}

function considerAutoApply(): void {
  if (state.phase !== 'available') return;
  const ok = shouldAutoApply({
    trigger: trigger.kind,
    manualRequested,
    touchedSinceTrigger: trigger.touched,
    msSinceTrigger: performance.now() - trigger.at,
    appIdle,
  });
  if (ok) apply();
}

function apply(): void {
  manualRequested = false;
  setState({ phase: 'applying' });
  if (!updateSW) {
    window.location.reload();
    return;
  }
  // 待機中の SW に SKIP_WAITING を送り、新しい版が activated になってから再読み込みする。
  // controllerchange は activating（まだ有効化の途中）で来るので、そこで読み直すと古い版の
  // 画面に戻ることがあった（検証で数回に1回）。controllerchange は有効化の通知が来ない場合の保険。
  reloadWhenActivated(registration?.waiting ?? null);
  void updateSW(true);
  window.setTimeout(() => {
    // 再読み込みが来なかった。もう一度押せる状態に戻す。ここで自動で再読み込みはしない
    // （入れ替えに失敗し続けると、起動→自動入れ替え→再読み込みの無限ループになるため）。
    if (state.phase === 'applying') setState({ phase: 'available', bannerDismissed: false });
  }, APPLY_TIMEOUT_MS);
}

/** 入れ替え後の再読み込みを1回だけ行う。新しい版の activated を待ち、来なければ支配の移動から少し待つ。 */
function reloadWhenActivated(sw: ServiceWorker | null): void {
  let done = false;
  const reload = (): void => {
    if (done) return;
    done = true;
    window.location.reload();
  };
  if (sw) {
    if (sw.state === 'activated') {
      reload();
      return;
    }
    sw.addEventListener('statechange', () => {
      if (sw.state === 'activated') reload();
    });
  }
  navigator.serviceWorker.addEventListener(
    'controllerchange',
    () => window.setTimeout(reload, RELOAD_FALLBACK_MS),
    { once: true },
  );
}

/** お知らせの「今すぐ更新」。 */
export function applyUpdateNow(): void {
  if (state.phase === 'available') apply();
}

/** お知らせの ✕。 */
export function dismissUpdateBanner(): void {
  setState({ bannerDismissed: true });
}

/** 設定の「アップデートを確認」。新しい版があればダウンロードを待って、そのまま入れ替える。 */
export async function checkForUpdate(): Promise<void> {
  if (state.phase === 'checking' || state.phase === 'applying') return;
  if (state.phase === 'available') {
    apply();
    return;
  }
  if (!registration) {
    // SW が無い（非対応ブラウザ・開発サーバ）。index.html は no-cache なので再読み込みで最新になる。
    setState({ phase: 'applying' });
    window.location.reload();
    return;
  }
  manualRequested = true;
  setState({ phase: 'checking' });
  lastCheckAt = performance.now();
  try {
    await registration.update();
  } catch {
    manualRequested = false;
    setState({ phase: 'error' });
    return;
  }
  // 待機に入った通知がすでに届いて入れ替えへ進んでいる（await の間に状態が変わりうるので読み直す）。
  if (getState().phase !== 'checking') return;
  if (registration.waiting) {
    onUpdateWaiting();
    return;
  }
  if (registration.installing) {
    // ダウンロード中。待機に入れば onUpdateWaiting が入れ替えまで進める。
    window.setTimeout(() => {
      if (state.phase !== 'checking') return;
      manualRequested = false;
      setState({ phase: 'error' });
    }, MANUAL_DOWNLOAD_TIMEOUT_MS);
    return;
  }
  manualRequested = false;
  setState({ phase: 'latest' });
}
