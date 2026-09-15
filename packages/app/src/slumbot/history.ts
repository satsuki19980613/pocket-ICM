/**
 * Slumbot HU のハンド履歴（SPEC §7.4.6）。
 *
 * 1 ハンドの記録は「Slumbot の action 文字列＋配られたカード＋収支」だけで完結する。
 * ストリート別のアクション・VPIP などの派生値はここで action 文字列から都度導く
 * （保存するのは元データだけにして、集計の定義を後から変えられるようにする）。
 * すべて純関数。IndexedDB / サーバへの保存は historyStore.ts / historySync.ts。
 */

import type { HandView } from './hand';
import { BOARD_COUNT, STACK, parseAction, type HandState } from './rules';

export interface HuHandRecord {
  /** `sb_` 始まりの端末生成 ID（サーバ側の冪等キーでもある）。 */
  readonly id: string;
  /** プレイした時刻（ms epoch）。 */
  readonly playedAt: number;
  /** 自分の席。0=BB / 1=SB(BTN)。 */
  readonly heroSeat: number;
  /** Slumbot の action 文字列（例 `b200c/kb100c/kk/b300f`）。 */
  readonly action: string;
  readonly heroCards: readonly string[];
  /** ショーダウンで開示された相手の手札。降りて終わったハンドは null。 */
  readonly botCards: readonly string[] | null;
  /** 到達したストリートまでのボード（0〜5 枚）。 */
  readonly board: readonly string[];
  /** このハンドの純収支（チップ・BB=100）。 */
  readonly winnings: number;
  /** ショーダウンまで行ったか。 */
  readonly showdown: boolean;
  /**
   * オールイン EV を織り込んだ純収支（チップ）。両者オールインで捲り合いになったハンドだけ
   * winnings と異なる。null は「まだ計算していない」。
   */
  readonly evWinnings: number | null;
  /** サーバに控えを送り終えたか。 */
  readonly synced: boolean;
}

export type StepKind = 'fold' | 'check' | 'call' | 'bet' | 'raise';

/** action 文字列の 1 手。 */
export interface ActionStep {
  readonly seat: number;
  /** 0=preflop … 3=river */
  readonly street: number;
  readonly kind: StepKind;
  /** そのストリートの「〜まで」の額（チップ）。fold / check は 0。 */
  readonly betTo: number;
  /** この 1 手で新たに出した額（チップ）。 */
  readonly put: number;
  /** 残りスタックを全部出した（または全部出した相手にコールした）。 */
  readonly allIn: boolean;
}

export interface HandWalk {
  readonly steps: readonly ActionStep[];
  readonly final: HandState;
  /** 両者オールインで捲り合いになったストリート（river 以前）。無ければ null。 */
  readonly allInStreet: number | null;
}

/** action 文字列を 1 手ずつに分解する。壊れていれば null。 */
export function walkActions(action: string): HandWalk | null {
  const steps: ActionStep[] = [];
  let allInStreet: number | null = null;
  const sz = action.length;
  let i = 0;
  while (i < sz) {
    const c = action[i]!;
    if (c === '/') {
      i += 1;
      continue;
    }
    const start = i;
    i += 1;
    if (c === 'b') {
      while (i < sz && action[i]! >= '0' && action[i]! <= '9') i += 1;
    }
    const before = parseAction(action.slice(0, start));
    if (!before.ok) return null;
    const s = before.state;
    const seat = s.toAct;
    if (seat < 0) return null;
    const mine = s.streetBet[seat] ?? 0;

    if (c === 'k') {
      steps.push({ seat, street: s.street, kind: 'check', betTo: 0, put: 0, allIn: false });
    } else if (c === 'f') {
      steps.push({ seat, street: s.street, kind: 'fold', betTo: 0, put: 0, allIn: false });
    } else if (c === 'c') {
      const allIn = s.totalLastBetTo >= STACK;
      steps.push({
        seat,
        street: s.street,
        kind: 'call',
        betTo: s.streetLastBetTo,
        put: s.streetLastBetTo - mine,
        allIn,
      });
      if (allIn && s.street < 3) allInStreet = s.street;
    } else if (c === 'b') {
      const betTo = Number.parseInt(action.slice(start + 1, i), 10);
      if (!Number.isFinite(betTo)) return null;
      const remaining = STACK - s.totalLastBetTo;
      const allIn = betTo - s.streetLastBetTo >= remaining;
      steps.push({
        seat,
        street: s.street,
        kind: s.streetLastBetTo > 0 ? 'raise' : 'bet',
        betTo,
        put: betTo - mine,
        allIn,
      });
    } else {
      return null;
    }
  }
  const fin = parseAction(action);
  if (!fin.ok) return null;
  return { steps, final: fin.state, allInStreet };
}

/** 記録の ID。`sb_` ＋ 時刻（36 進）＋ 乱数 4 桁。tenfour の 6 桁 ID と衝突しない。 */
export function newHandId(now: number = Date.now(), rand: () => number = Math.random): string {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
  let tail = '';
  for (let k = 0; k < 4; k += 1) tail += chars[Math.floor(rand() * 36) % 36];
  return `sb_${now.toString(36)}${tail}`;
}

/** ID の形（サーバの CHECK 制約と同じ）。 */
export const HAND_ID_RE = /^sb_[0-9a-z]{6,24}$/;

/**
 * ハンド終了時の画面状態から記録を作る。終わっていなければ null。
 * ボードは到達したストリートまでに切り詰める（Slumbot は先のカードも返してくるため）。
 */
export function buildRecord(view: HandView, playedAt: number, id: string): HuHandRecord | null {
  if (!view.over) return null;
  const w = walkActions(view.action);
  if (!w) return null;
  const fin = w.final;
  const board = view.board.slice(0, BOARD_COUNT[fin.street] ?? 0);
  const winnings = Math.trunc(view.winnings ?? 0);
  const showdown = !fin.folded;
  return {
    id,
    playedAt,
    heroSeat: view.heroSeat,
    action: view.action,
    heroCards: [...view.holeCards],
    // Slumbot は降りて終わったハンドでも手札を開示してくる（tenfour も降りた人の手札を載せる）。
    // 返ってきたものはそのまま残す。
    botCards: view.botCards && view.botCards.length === 2 ? [...view.botCards] : null,
    board,
    winnings,
    showdown,
    // 捲り合いが無ければ EV は実収支そのもの。捲り合いは allInEv.ts が後から埋める。
    evWinnings: w.allInStreet === null ? winnings : null,
    synced: false,
  };
}

/** プリフロップの統計に使う 1 ハンドぶんの事実。 */
export interface PreflopFacts {
  /** 自分にプリフロップの選択機会があった（BB で相手が先に降りた walk は無し）。 */
  readonly vpipOpp: boolean;
  readonly vpip: boolean;
  readonly pfr: boolean;
  /** 相手のオープンレイズを受けて自分が動く番があった。 */
  readonly threeBetOpp: boolean;
  readonly threeBet: boolean;
}

export function preflopFacts(steps: readonly ActionStep[], heroSeat: number): PreflopFacts {
  let vpipOpp = false;
  let vpip = false;
  let pfr = false;
  let threeBetOpp = false;
  let threeBet = false;
  let raises = 0;
  let firstRaiser = -1;
  for (const st of steps) {
    if (st.street !== 0) break;
    const raise = st.kind === 'bet' || st.kind === 'raise';
    if (st.seat === heroSeat) {
      vpipOpp = true;
      if (st.kind === 'call' || raise) vpip = true;
      if (raise) pfr = true;
      if (raises === 1 && firstRaiser !== heroSeat) {
        threeBetOpp = true;
        if (raise) threeBet = true;
      }
    }
    if (raise) {
      if (raises === 0) firstRaiser = st.seat;
      raises += 1;
    }
  }
  return { vpipOpp, vpip, pfr, threeBetOpp, threeBet };
}

/** 記録が壊れていないか（IndexedDB / サーバから読んだものの検査）。 */
export function isHandRecord(v: unknown): v is HuHandRecord {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  const cards = (x: unknown): boolean =>
    Array.isArray(x) && x.every((c) => typeof c === 'string' && c.length === 2);
  return (
    typeof o.id === 'string' &&
    HAND_ID_RE.test(o.id) &&
    typeof o.playedAt === 'number' &&
    Number.isFinite(o.playedAt) &&
    (o.heroSeat === 0 || o.heroSeat === 1) &&
    typeof o.action === 'string' &&
    cards(o.heroCards) &&
    (o.heroCards as unknown[]).length === 2 &&
    (o.botCards === null || (cards(o.botCards) && (o.botCards as unknown[]).length === 2)) &&
    cards(o.board) &&
    (o.board as unknown[]).length <= 5 &&
    typeof o.winnings === 'number' &&
    Number.isFinite(o.winnings) &&
    typeof o.showdown === 'boolean' &&
    (o.evWinnings === null || (typeof o.evWinnings === 'number' && Number.isFinite(o.evWinnings))) &&
    typeof o.synced === 'boolean'
  );
}
