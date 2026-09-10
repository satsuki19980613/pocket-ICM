/**
 * 画面の階層モデル。端末の「戻る」を1階層戻るへ翻訳するために、
 * 各画面が「ホームから何階層潜っているか」を定義する（navHistory.ts が履歴に反映する）。
 *
 * 深さは backFor()（ヘッダの ‹ の飛び先）と必ず一致させること。
 * 例: result はヘッダで記録タブ／スレッドへ戻る＝その1つ下なので 2。
 */

export type Screen =
  | 'home'
  | 'thread'
  | 'userpub'
  | 'icm'
  | 'confirm'
  | 'result'
  | 'error'
  | 'history'
  | 'training'
  | 'slumbot'
  | 'settings'
  | 'admin';

/** 深さの判定に効く「どこから開いたか」。 */
export interface NavContext {
  /** 公開結果一覧をスレッドから開いた（ホームからなら1階層、スレッドからなら2階層）。 */
  readonly pubFromThread: boolean;
}

export const NAV_CONTEXT_ROOT: NavContext = { pubFromThread: false };

/** ホーム=0。タブ画面とスレッドは1。そこからさらに潜る画面は2。 */
export function screenDepth(screen: Screen, ctx: NavContext = NAV_CONTEXT_ROOT): number {
  switch (screen) {
    case 'home':
      return 0;
    case 'icm':
    case 'training':
    case 'history':
    case 'settings':
    case 'thread':
      return 1;
    case 'userpub':
      return ctx.pubFromThread ? 2 : 1;
    case 'confirm':
    case 'error':
    case 'admin':
    // Training ハブ（深さ1）から潜る機能画面。
    // ランキングは画面ではなく重なり（backLayers）なのでここには無い。
    case 'slumbot':
      return 2;
    case 'result':
      // 記録タブ（深さ1）からもスレッド（深さ1）からも、その1つ下。
      return 2;
  }
}
