/**
 * アプリ更新（新しい版の Service Worker が待機に入った）を「いま自動で入れ替えてよいか」の判定と、
 * いま動いている版の求め方。DOM・SW に依存しない純関数なので node の単体テストで検証する。
 * 仕組みの本体は appUpdate.ts。
 */

/** 更新を探し始めた契機。launch=起動（ページ読み込み）、resume=裏から戻った。 */
export type UpdateTrigger = 'launch' | 'resume';

export interface UpdateContext {
  readonly trigger: UpdateTrigger;
  /** 設定の「アップデートを確認」が押されて、その結果を待っている。 */
  readonly manualRequested: boolean;
  /** 契機のあとに利用者が画面を触った（タップ・キー入力）。 */
  readonly touchedSinceTrigger: boolean;
  /** 契機からの経過ミリ秒。 */
  readonly msSinceTrigger: number;
  /** アプリが「いま再読み込みしても失うものが無い」状態（入力途中・計算中・対局中でない）。 */
  readonly appIdle: boolean;
}

/**
 * 起動・復帰から自動で入れ替えてよい時間。新しい版のダウンロード（数 MB）が済むのを待つ上限で、
 * これを過ぎて届いた更新は、触っていなくてもお知らせにとどめる（急に画面が変わると驚くため）。
 */
export const AUTO_APPLY_WINDOW_MS = 30_000;

/**
 * 待機中の新しい版を、利用者に聞かずに入れ替えて再読み込みしてよいか。
 *
 * - 手動確認中（設定のボタン）なら入れ替える。利用者が自分で頼んだ操作。
 * - 契機のあと画面を触っていたら入れ替えない。操作中に画面が消えるのを防ぐ。
 * - 起動直後は入れ替える。state がまだ空なので失うものが無い。
 * - 裏から戻った直後は、画面の state（入力途中のフォーム・計算中のジョブ・対局中のハンド）が
 *   残っているので、アプリが「失うものが無い」と申告しているときだけ入れ替える。
 */
export function shouldAutoApply(ctx: UpdateContext): boolean {
  if (ctx.manualRequested) return true;
  if (ctx.touchedSinceTrigger) return false;
  if (ctx.msSinceTrigger > AUTO_APPLY_WINDOW_MS) return false;
  if (ctx.trigger === 'launch') return true;
  return ctx.appIdle;
}

/**
 * いま動いている版の表示名。本番はエントリのバンドル名 `assets/index-<ハッシュ>.js` の
 * ハッシュ部分（中身から決まるので、同じ名前なら同じ中身＝本番との照合にそのまま使える）。
 * バンドル前（開発サーバ）は 'dev'。
 */
export function versionFromBundleUrl(url: string): string {
  const m = /\/index-([A-Za-z0-9_-]+)\.js(?:[?#].*)?$/.exec(url);
  return m?.[1] ?? 'dev';
}
