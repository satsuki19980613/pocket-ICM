/**
 * Slumbot HU の 1 ハンド記録（`HuHandRecord`）→ 共通ビューモデル（`HandDetailView`）。
 *
 * 保存されているのは action 文字列・配られたカード・収支だけ（`slumbot/history.ts`）。
 * ストリートごとのポット・ステップはここで `walkActions` の結果と `slumbot/rules.ts` の
 * `committed` から毎回組み立てる。よって既に登録済みの記録もそのまま正しく表示できる。
 *
 * ポット（そのストリートが始まった時点の額）の規則は `slumbot/tenfour.ts` の `streetPots`
 * と共通の `history/pots.ts`（`huStreetPotChips`）から取る。最終ポット（`finalPotBb`/
 * `wonBb`）も同じく `history/pots.ts` の `contestedPotChips`（SNG 版と共通）を使う。
 * 1 か所に規則を置くことで二重実装を避けている（値が一致することは
 * `huHandView.test.ts` の契約テストでも保証）。
 */

import { walkActions, type ActionStep, type HuHandRecord } from '../slumbot/history';
import { BB, BOARD_COUNT, committed, signedBbLabel, type HandState } from '../slumbot/rules';
import { BOT_NAME } from '../slumbot/tenfour';
import {
  STREET_VIEW_LABEL,
  toBbView,
  type HandDetailView,
  type HandPlayerView,
  type HandResultView,
  type HandStepView,
  type HandStreetView,
} from './handView';
import { contestedPotChips, huStreetPotChips } from './pots';

const VILLAIN_NAME = BOT_NAME.toUpperCase(); // 'SLUMBOT'

function posOf(seat: number): string {
  return seat === 1 ? 'SB' : 'BB';
}

const STEP_LABEL: Record<ActionStep['kind'], string> = {
  fold: 'FOLD',
  check: 'CHECK',
  call: 'CALL',
  bet: 'BET',
  raise: 'RAISE',
};

function stepView(st: ActionStep, heroSeat: number): HandStepView {
  return {
    pos: posOf(st.seat),
    name: st.seat === heroSeat ? 'YOU' : VILLAIN_NAME,
    isHero: st.seat === heroSeat,
    label: st.allIn ? 'ALL IN' : STEP_LABEL[st.kind],
    amountBb: st.kind === 'fold' || st.kind === 'check' ? null : toBbView(st.betTo, BB),
    allIn: st.allIn,
    auto: false,
  };
}

function p2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 見出し（'9/15 21:17'・月/日 時:分・ローカル時刻）。 */
function titleOf(playedAt: number): string {
  const d = new Date(playedAt);
  return `${d.getMonth() + 1}/${d.getDate()} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

export function huHandView(rec: HuHandRecord): HandDetailView | null {
  const w = walkActions(rec.action);
  if (!w) return null;
  const fin: HandState = w.final;
  const heroSeat = rec.heroSeat;

  const players: HandPlayerView[] = [1, 0].map((seat) => ({
    seat,
    pos: posOf(seat),
    name: seat === heroSeat ? 'YOU' : VILLAIN_NAME,
    isHero: seat === heroSeat,
    netBb: toBbView(seat === heroSeat ? rec.winnings : -rec.winnings, BB),
    cards: seat === heroSeat ? [...rec.heroCards] : rec.botCards ? [...rec.botCards] : null,
  }));

  // 到達したストリート（オールインならリバーまで走る）。
  const reached = fin.allIn ? 3 : fin.street;
  const streets: HandStreetView[] = [];
  for (let s = 0; s <= reached; s += 1) {
    const prevCount = s === 0 ? 0 : (BOARD_COUNT[s - 1] ?? 0);
    const count = BOARD_COUNT[s] ?? 5;
    streets.push({
      street: s,
      label: STREET_VIEW_LABEL[s]!,
      potBb: toBbView(huStreetPotChips(w.steps, s), BB),
      board: rec.board.slice(prevCount, count),
      steps: w.steps.filter((st) => st.street === s).map((st) => stepView(st, heroSeat)),
    });
  }

  const commit0 = committed(fin, 0);
  const commit1 = committed(fin, 1);
  const notes: string[] = [];
  if (rec.evWinnings !== null && rec.evWinnings !== rec.winnings) {
    notes.push(`ALL-IN EV ${signedBbLabel(rec.evWinnings - rec.winnings)}bb`);
  }
  const winners: string[] =
    rec.winnings > 0 ? ['YOU'] : rec.winnings < 0 ? [VILLAIN_NAME] : ['YOU', VILLAIN_NAME];

  // 実際に奪い合われた額（コールされなかった上乗せは元の持ち主に戻るので数えない。
  // ポーカーのハンドヒストリーの慣習＝tenfour の result_won_bb と同じ考え方）。SNG 版と
  // 共通の `contestedPotChips`（history/pots.ts）を使う。2 人なら 2×min(commit0,commit1)
  // と必ず同じ値になる（pots.test.ts で確認済み）。
  const wonChips = contestedPotChips([commit0, commit1]);

  const result: HandResultView = {
    winners,
    wonBb: toBbView(wonChips, BB),
    showdown: !fin.folded,
    finalPotBb: toBbView(wonChips, BB),
    notes,
  };

  return {
    key: rec.id,
    title: titleOf(rec.playedAt),
    subtitle: '200bb スタート',
    heroCards: [...rec.heroCards],
    players,
    streets,
    result,
  };
}
