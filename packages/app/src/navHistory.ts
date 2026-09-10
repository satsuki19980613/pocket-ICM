/**
 * 端末の「戻る」（Android のハードウェアキー/ジェスチャ）をアプリ内の1階層戻るに割り当てる。
 *
 * 背景: 本アプリはルータを持たず、画面遷移を React state だけで表している。
 * そのため履歴エントリが1つしか無く、端末の戻るはドキュメント離脱＝PWA だとアプリ終了になる。
 * そこで「アプリ内の階層の深さ」と同じ数だけ同一 URL のダミー履歴エントリを積み、
 * popstate をアプリ内の1階層戻るへ翻訳する。深さ0（ルートのタブ画面）では
 * ダミーが無いので、端末の戻るは従来どおりアプリ終了になる（Android の標準挙動）。
 *
 * DOM に依存しない（History だけを注入する）ので node 環境の単体テストで検証できる。
 */

/** 使う範囲だけを写した History の最小インターフェース。 */
export interface HistoryLike {
  readonly state: unknown;
  pushState(data: unknown, unused: string): void;
  go(delta: number): void;
}

/** 積んだダミーエントリの目印。他所の history.state と衝突しない名前にする。 */
export const NAV_DEPTH_KEY = '__icmNavDepth';

/** history.state から深さを読む（未知の形なら 0）。 */
export function depthOfState(state: unknown): number {
  if (typeof state !== 'object' || state === null) return 0;
  const v = (state as Record<string, unknown>)[NAV_DEPTH_KEY];
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/**
 * 深さ prev → next の差分を履歴操作の計画に変換する純関数。
 * 正= push する数、負= go(-n) する数、0= 何もしない。
 */
export function planHistorySync(prev: number, next: number): number {
  const p = Math.max(0, Math.floor(prev));
  const n = Math.max(0, Math.floor(next));
  return n - p;
}

export interface BackController {
  /** アプリの階層の深さが変わるたびに呼ぶ（描画後の effect から）。 */
  sync(depth: number): void;
  /** popstate ハンドラから呼ぶ。true ならアプリ内を1階層戻す。 */
  handlePop(): boolean;
  /** コントローラが把握している深さ（テスト用）。 */
  readonly depth: number;
}

/**
 * 戻る制御の本体。
 *
 * - sync(d): 履歴エントリ数をアプリの深さ d に合わせる。深くなった分は pushState、
 *   浅くなった分（ヘッダの戻る・モーダルの×で閉じた等）は go(-n) で履歴も戻す。
 *   自分で起こした popstate は無視カウンタで読み飛ばし、二重に戻らないようにする。
 * - handlePop(): 端末の戻るによる popstate なら true。深さは popstate 後の
 *   history.state から読み直すので、想定外のズレ（リロード・履歴メニュー等）があっても
 *   次の sync() で自動的に整合する。
 * - 生成時に前回セッションのダミーが残っていたら（リロード時に history.state は残る）
 *   その分を巻き戻してから開始する。これをしないと初回 sync(0) がアプリを離脱させる。
 */
export function createBackController(h: HistoryLike): BackController {
  let depth = 0;
  let ignore = 0;

  const stale = depthOfState(h.state);
  if (stale > 0) {
    ignore += 1; // go() が起こす popstate は1回だけ。
    h.go(-stale);
  }

  return {
    get depth(): number {
      return depth;
    },

    sync(next: number): void {
      const delta = planHistorySync(depth, next);
      if (delta === 0) return;
      if (delta > 0) {
        for (let i = 0; i < delta; i += 1) {
          depth += 1;
          h.pushState({ [NAV_DEPTH_KEY]: depth }, '');
        }
      } else {
        depth = Math.max(0, next);
        ignore += 1; // go(-n) が起こす popstate は n 回ではなく1回。
        h.go(delta);
      }
    },

    handlePop(): boolean {
      if (ignore > 0) {
        // 自分で起こした go() の分。深さは go() の時点で更新済みなので触らない
        // （非同期の traversal 中に新しい sync() が来ていても巻き戻さないため）。
        ignore -= 1;
        return false;
      }
      const actual = depthOfState(h.state);
      const prev = depth;
      depth = actual; // 想定外のズレはここで実際の履歴に合わせ直す。
      return actual < prev;
    },
  };
}
