/**
 * エンジンの公開 API（契約）。実装は `engine/` 配下（担当 A1）。
 *
 * ここに書いたシグネチャは Worker（A2）とアプリ（A3a/A3b）が既に前提にしているので、
 * 実装側の都合で変えない。変えたくなったら指揮役へ。
 *
 * すべて **純関数**。時刻 `now` と乱数 `rng` は外から渡す（テストは決定的に）。
 */

import type {
  ActionKind,
  LegalActions,
  PublicHand,
  PublicTable,
  SngConfig,
  SngGameResult,
  SngHandRecord,
  TableState,
  You,
} from './types';

/** 0 以上 1 未満の乱数。サーバーは crypto.getRandomValues で作る。 */
export type Rng = () => number;

export type EngineCommand =
  | {
      readonly t: 'join';
      readonly userId: string;
      readonly name: string;
      /**
       * アイコンの参照（PlayerState.avatarUrl と同じ形）。省略可（テスト等で渡さない場合は
       * null 扱いになる。実際の呼び出し元 worker/sng/table.ts は毎回 auth.avatarUrl を渡す）。
       */
      readonly avatarUrl?: string | null;
    }
  | { readonly t: 'leave'; readonly userId: string }
  | { readonly t: 'sitin'; readonly userId: string }
  | { readonly t: 'connected'; readonly userId: string; readonly connected: boolean }
  | {
      readonly t: 'act';
      readonly userId: string;
      readonly handNo: number;
      readonly actSeq: number;
      readonly kind: ActionKind;
      readonly betTo?: number;
    }
  /** alarm が鳴った（`state.wake.kind` を見て何をするか決める）。 */
  | { readonly t: 'wake' };

export type EngineEffect =
  /** ハンドが終わった（DB に書く・履歴へ）。 */
  | { readonly t: 'hand_finished'; readonly record: SngHandRecord; readonly holes: Readonly<Record<string, readonly [string, string]>> }
  /** 本人にだけ手札を送る。 */
  | { readonly t: 'hole'; readonly userId: string; readonly handNo: number; readonly cards: readonly [string, string] }
  /** 試合が終わった（finished / cancelled）。 */
  | { readonly t: 'game_over'; readonly result: SngGameResult }
  /** ロビーの一覧に影響する変化があった（人数・状態）。 */
  | { readonly t: 'lobby_changed' };

export type EngineError =
  | 'stale'
  | 'not_your_turn'
  | 'illegal'
  | 'room_full'
  | 'room_closed'
  | 'not_seated';

export type EngineResult =
  | { readonly ok: true; readonly state: TableState; readonly effects: readonly EngineEffect[] }
  | { readonly ok: false; readonly error: EngineError };

export interface Engine {
  /** 待機中の部屋を作る（作成者は着席済み）。hostAvatarUrl は省略可（省略時は null）。 */
  createTable(
    roomId: string,
    hostId: string,
    hostName: string,
    config: SngConfig,
    now: number,
    hostAvatarUrl?: string | null,
  ): TableState;
  /** コマンドを適用する。状態が変わらない場合も ok:true で同じ state を返してよい。 */
  apply(state: TableState, cmd: EngineCommand, now: number, rng: Rng): EngineResult;
  /** その席の合法手（手番でなければ全部 false / null）。 */
  legalActions(hand: PublicHand, seat: number, stack: number): LegalActions;
  /** クライアントへ見せる形（秘密を落とす）。 */
  publicTable(state: TableState): PublicTable;
  you(state: TableState, userId: string): You;
  /** ハンド開始時に使うレベル（1 始まり）。 */
  levelAt(config: SngConfig, startedAt: number, now: number): number;
}

// 実装は engine/index.ts から差し込む（A1）。
export { engine } from './engine/index';
