/**
 * アプリの想定外のエラーを、管理者の診断ログ（client_errors, 0009）へ送る前の整形と間引き（純ロジック）。
 * 送信の配線は supabase/clientErrors.ts。
 *
 * 送るのはエラーの文面・スタックだけ（入力中の値や画像は含めない）。同じエラーの繰り返しは1回の起動で
 * 1回だけ、合計も1回の起動で MAX_REPORTS_PER_SESSION 件まで（サーバ側でも1人1時間30件に絞る）。
 */

/**
 * error=実行時エラー / rejection=非同期処理の失敗 / render=画面の描画失敗 / ocr=OCR の例外 /
 * sync=サーバへの保存失敗（画像・読み取りログ・計算記録。今までは握りつぶしていたもの）。
 * 0009 の client_errors.kind の CHECK と揃える。
 */
export type ClientErrorKind = 'error' | 'rejection' | 'render' | 'ocr' | 'sync';

/** 0009 の CHECK（message 500 文字・detail 4000 文字）と揃える。 */
export const MESSAGE_MAX = 500;
export const DETAIL_MAX = 4000;
/** 1回の起動で送る上限（同じエラーの繰り返しは数えない）。 */
export const MAX_REPORTS_PER_SESSION = 20;

/** 長すぎる文字列を max 文字（末尾の … を含む）に切り詰める。 */
export function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

export interface DescribedError {
  message: string;
  detail: string | null;
}

function stringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

/** 何が投げられても（Error・文字列・Supabase のエラーオブジェクト・その他）文面と詳細に直す。 */
export function describeError(err: unknown): DescribedError {
  if (err instanceof Error) {
    const head = err.message ? (err.name && err.name !== 'Error' ? `${err.name}: ${err.message}` : err.message) : err.name || 'Error';
    return { message: clip(head, MESSAGE_MAX), detail: err.stack ? clip(err.stack, DETAIL_MAX) : null };
  }
  if (typeof err === 'string') {
    return { message: clip(err || '(空のエラー)', MESSAGE_MAX), detail: null };
  }
  if (typeof err === 'object' && err !== null && typeof (err as { message?: unknown }).message === 'string') {
    const message = (err as { message: string }).message || '(空のエラー)';
    return { message: clip(message, MESSAGE_MAX), detail: clip(stringify(err), DETAIL_MAX) };
  }
  return { message: clip(stringify(err) || '(不明なエラー)', MESSAGE_MAX), detail: null };
}

const NOISE_MESSAGES = [
  // ブラウザが出す無害な警告（レイアウトの再計算が1フレームに収まらなかった）。
  /ResizeObserver loop/i,
  // 別オリジンのスクリプトのエラー（中身が伏せられていて調べようがない）。
  /^Script error\.?$/i,
];

/** アプリの不具合ではないもの（ブラウザの無害な警告・拡張機能が差し込んだスクリプトのエラー）。 */
export function isNoise(d: DescribedError): boolean {
  if (NOISE_MESSAGES.some((re) => re.test(d.message))) return true;
  return /(chrome|moz|safari(-web)?)-extension:\/\//.test(d.detail ?? '');
}

/** 同じエラーかどうかの見分け（種類＋文面）。 */
export function reportKey(kind: ClientErrorKind, message: string): string {
  return `${kind}\n${message}`;
}

/** 1回の起動ぶんの送信の間引き。同じ key は1回だけ・合計 max 件まで通す。 */
export function createReportGate(max: number = MAX_REPORTS_PER_SESSION): { admit(key: string): boolean } {
  const seen = new Set<string>();
  return {
    admit(key: string): boolean {
      if (seen.has(key) || seen.size >= max) return false;
      seen.add(key);
      return true;
    },
  };
}

/** 詳細（スタック・部品の位置・どこで起きたか）をつないで1つにする。何も無ければ null。 */
export function joinDetail(...parts: (string | null | undefined)[]): string | null {
  const s = parts.filter((p): p is string => typeof p === 'string' && p.trim() !== '').join('\n---\n');
  return s ? clip(s, DETAIL_MAX) : null;
}
