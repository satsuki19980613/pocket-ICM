/**
 * アプリの想定外のエラーを client_errors（0009・管理者だけが読める）へ送る配線。
 * 整形と間引きは diagnostics/errorReport.ts（純ロジック）。
 *
 * - 送信は投げっぱなし。失敗しても何もしない（送信の失敗をさらに送る、は起こさない）。
 * - 未ログイン・バックエンド未設定なら送らない（client_errors はメンバー本人の行しか書けない）。
 * - 送るのはエラーの文面・スタック・画面名・アプリの版・端末の種類（UA・画面の大きさ）だけ。
 *   入力中の値や画像は送らない。
 */
import { supabase, isConfigured } from './client';
import {
  createReportGate,
  describeError,
  isNoise,
  joinDetail,
  reportKey,
  type ClientErrorKind,
} from '../diagnostics/errorReport';

const gate = createReportGate();
let appVersion: string | null = null;
let currentScreen: string | null = null;

/** いまの画面名（App が画面を切り替えるたびに入れる）。エラーがどの画面で起きたかの手がかり。 */
export function setReportScreen(screen: string): void {
  currentScreen = screen;
}

/** エラーを1件送る（投げっぱなし・例外を投げない）。extra はどこで起きたかなどの補足。 */
export function reportClientError(kind: ClientErrorKind, err: unknown, extra?: string | null): void {
  void send(kind, err, extra).catch(() => undefined);
}

async function send(kind: ClientErrorKind, err: unknown, extra: string | null | undefined): Promise<void> {
  if (!isConfigured) return;
  const d = describeError(err);
  if (isNoise(d)) return;
  if (!gate.admit(reportKey(kind, d.message))) return;
  const { data } = await supabase.auth.getSession();
  const uid = data.session?.user.id;
  if (!uid) return;
  await supabase.from('client_errors').insert({
    owner: uid,
    kind,
    message: d.message,
    detail: joinDetail(d.detail, extra),
    screen: currentScreen,
    app_version: appVersion,
    device: {
      ua: navigator.userAgent.slice(0, 300),
      dpr: window.devicePixelRatio || 1,
      w: window.innerWidth,
      h: window.innerHeight,
    },
  });
}

/**
 * どこにも受け止められなかったエラー（実行時エラー・非同期処理の失敗）を拾って送る。
 * 描画中の例外は ErrorBoundary が、OCR の例外やサーバへの保存失敗は App が個別に送る。
 */
export function installGlobalErrorReporting(version: string): void {
  appVersion = version;
  window.addEventListener('error', (e) => {
    reportClientError('error', e.error ?? e.message, e.filename ? `${e.filename}:${e.lineno}:${e.colno}` : null);
  });
  window.addEventListener('unhandledrejection', (e) => {
    reportClientError('rejection', e.reason);
  });
}
