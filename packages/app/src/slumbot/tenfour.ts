/**
 * ハンド記録 → tenfour_watcher 形式（1 ハンド 1 JSON）への変換（SPEC §7.4.6）。
 *
 * 形は tenfour_watcher の `src/models.py`（ParsedHand）に合わせる。取り込みは
 * `data/tenfour_hands/` 配下に置いて `python -m src.db reindex`。必須は `hand_id` だけだが、
 * 派生列（局面・SPR）が同じ関数で出せるよう、players / actions / board / street_pots も
 * 同じ規則で埋める:
 *   - ポジションは SB（ボタン）/ BB。プレイヤー順も SB → BB（tenfour の卓順の末尾 2 つ）
 *   - 金額はそのストリートの「〜まで」の bb（Raise 2.0 / Call 2.0 / Bet 3.25 / Call 3.25）
 *   - `street_pots` はそのストリートが始まった時点のポット
 *   - `result_won_bb` は勝者が実際に獲得したポット（コールされなかった分は含めない）
 */

import { walkActions, type ActionStep, type HuHandRecord } from './history';
import { committed, type HandState } from './rules';

export const BOT_NAME = 'Slumbot';
const STREETS = ['preflop', 'flop', 'turn', 'river'] as const;

export interface TenfourCard {
  readonly rank: string;
  readonly suit: string;
}

export interface TenfourPlayer {
  readonly position: string;
  readonly name: string;
  readonly stack_delta_bb: number | null;
  readonly cards: readonly TenfourCard[];
  readonly is_hero: boolean;
}

export interface TenfourAction {
  readonly position: string;
  readonly name: string;
  readonly action: string;
  readonly amount_bb: number | null;
  readonly street: string;
}

export interface TenfourHand {
  readonly source_file: string;
  readonly parsed_at: string;
  readonly hand_id: string;
  readonly timestamp: string;
  readonly hero_name: string;
  readonly hero_position: string;
  readonly hero_cards: readonly TenfourCard[];
  readonly players: readonly TenfourPlayer[];
  readonly board: Record<string, readonly TenfourCard[]>;
  readonly actions: readonly TenfourAction[];
  readonly street_pots: Record<string, number>;
  readonly result_winner: string;
  readonly result_won_bb: number | null;
  readonly raw_ocr: Record<string, string>;
  readonly parse_errors: readonly string[];
  // ---- tenfour には無い追加情報（raw_json に残る）----
  readonly source: 'slumbot';
  readonly stack_bb: number;
  readonly slumbot_action: string;
  /** オールイン EV 込みの収支と実収支の差（bb）。捲り合いが無ければ 0。 */
  readonly allin_ev_delta_bb: number;
}

const UNKNOWN: TenfourCard = { rank: '?', suit: '?' };

export function toTenfourCard(code: string | undefined): TenfourCard {
  if (!code || code.length !== 2) return UNKNOWN;
  const rank = code[0]!.toUpperCase();
  const suit = code[1]!.toLowerCase();
  if (!'AKQJT98765432'.includes(rank) || !'shdc'.includes(suit)) return UNKNOWN;
  return { rank, suit };
}

function twoCards(cards: readonly string[] | null): TenfourCard[] {
  return [toTenfourCard(cards?.[0]), toTenfourCard(cards?.[1])];
}

const p2 = (n: number): string => String(n).padStart(2, '0');

/** tenfour の `timestamp`（"2026/08/19 05:42"・端末のローカル時刻）。 */
export function tenfourTimestamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

/** tenfour の `parsed_at`（"2026-08-22T15:47:47"・タイムゾーン無しのローカル時刻）。 */
export function tenfourParsedAt(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/** 書き出すファイル名（tenfour の `tenfour_20260819_0542_easzNx.json` に倣う）。 */
export function tenfourFileName(rec: HuHandRecord): string {
  const d = new Date(rec.playedAt);
  const ymd = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`;
  const hm = `${p2(d.getHours())}${p2(d.getMinutes())}`;
  return `slumbot_${ymd}_${hm}_${rec.id.slice(3)}.json`;
}

/** ZIP 内のフォルダ（tenfour と同じく日付で分ける）。 */
export function tenfourFolder(rec: HuHandRecord): string {
  const d = new Date(rec.playedAt);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}

const bb = (chips: number): number => Math.round(chips) / 100;

const ACTION_LABEL: Record<ActionStep['kind'], string> = {
  fold: 'Fold',
  check: 'Check',
  call: 'Call',
  bet: 'Bet',
  raise: 'Raise',
};

function posOf(seat: number): string {
  return seat === 1 ? 'SB' : 'BB';
}

/** 各ストリート開始時点のポット（チップ）。到達したストリートだけ。 */
function streetPots(steps: readonly ActionStep[], fin: HandState): Record<string, number> {
  const out: Record<string, number> = {};
  const reached = fin.allIn ? 3 : fin.street;
  for (let s = 1; s <= reached; s += 1) {
    let pot = 150; // SB 50 + BB 100
    for (const st of steps) if (st.street < s) pot += st.put;
    out[STREETS[s]!] = bb(pot);
  }
  if (!fin.folded) out.showdown = bb(committed(fin, 0) + committed(fin, 1));
  return out;
}

export function toTenfourHand(rec: HuHandRecord, heroName: string, now: number = Date.now()): TenfourHand | null {
  const w = walkActions(rec.action);
  if (!w) return null;
  const fin = w.final;
  const heroPos = posOf(rec.heroSeat);
  const nameOf = (seat: number): string => (seat === rec.heroSeat ? heroName : BOT_NAME);

  const players: TenfourPlayer[] = [1, 0].map((seat) => ({
    position: posOf(seat),
    name: nameOf(seat),
    stack_delta_bb: bb(seat === rec.heroSeat ? rec.winnings : -rec.winnings),
    cards: twoCards(seat === rec.heroSeat ? rec.heroCards : rec.botCards),
    is_hero: seat === rec.heroSeat,
  }));

  const actions: TenfourAction[] = w.steps.map((st) => ({
    position: posOf(st.seat),
    name: nameOf(st.seat),
    action: ACTION_LABEL[st.kind],
    amount_bb: st.kind === 'fold' || st.kind === 'check' ? null : bb(st.betTo),
    street: STREETS[st.street]!,
  }));

  const board: Record<string, TenfourCard[]> = {};
  if (rec.board.length >= 3) board.flop = rec.board.slice(0, 3).map(toTenfourCard);
  if (rec.board.length >= 4) board.turn = [toTenfourCard(rec.board[3])];
  if (rec.board.length >= 5) board.river = [toTenfourCard(rec.board[4])];

  // 勝者が持ち帰るのは「両者が出した額のうち少ない方 × 2」。降ろした側のコールされなかった
  // 上乗せは戻る（tenfour の "won" と同じ数え方）。
  const contested = 2 * Math.min(committed(fin, 0), committed(fin, 1));
  const winner = rec.winnings > 0 ? heroName : rec.winnings < 0 ? BOT_NAME : '';

  return {
    source_file: '',
    parsed_at: tenfourParsedAt(now),
    hand_id: rec.id,
    timestamp: tenfourTimestamp(rec.playedAt),
    hero_name: heroName,
    hero_position: heroPos,
    hero_cards: twoCards(rec.heroCards),
    players,
    board,
    actions,
    street_pots: streetPots(w.steps, fin),
    result_winner: winner,
    result_won_bb: winner ? bb(contested) : null,
    raw_ocr: {},
    parse_errors: [],
    source: 'slumbot',
    stack_bb: 200,
    slumbot_action: rec.action,
    allin_ev_delta_bb: bb((rec.evWinnings ?? rec.winnings) - rec.winnings),
  };
}
