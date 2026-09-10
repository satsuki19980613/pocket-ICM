/**
 * 総チップ保存による整合性チェック／補正（さつき決定 2026-09-09・クラブマッチ）。
 *
 * クラブマッチは総チップが保存される（6 人 × 15,000 = 90,000・1 テーブル）。ブラインドを
 * レベル表にスナップして BB（チップ）が確定すると、**場の総 BB = 90,000 ÷ BB** が理論的に定まる。
 * これを正として OCR で読んだスタック合計と照合し、
 *   - 1 席だけ読めない（NaN）→ 保存則から**その席のスタックを復元**、
 *   - 全席読めたが合計が理論値とわずかにずれる → **最低信頼度の席で差分を調整**、
 *   - 差が大きすぎる（モード不一致・重大誤読の疑い）→ **何もしない**（誤補正を避ける）。
 *
 * 保存則（オールイン無しのプリフロップ）:
 *   総BB = Σ(各占有席の表示スタック) + デッドポット
 *   デッドポット = Σアンティ拠出 + SB(0.5) + BB(1)
 * （表示スタックはブラインド/アンティ投函後の値。デッドポットにそれらを1回だけ計上＝二重計上しない。）
 *
 * blindChips が無い（レベル未確定・非クラブマッチ扱い）／chips 表示のときは無効（reads をそのまま
 * 返す＝従来挙動・回帰ゼロ）。オールイン在席（Phase 4）は、ポット = antePot + Σbets を計算して
 * OCR ポットと照合し（①）、総チップ保存はフラグのみ計上する（②・自動補正はしない。非クラブ混入で
 * 90,000÷bb に乗らないため危険）。全オールイン席のベットが読めないフレームは保留（allin-unread-skip）。
 */

import type { RawReads, RawSeatRead } from './types.js';
import { totalBbFromBbChips } from './blindLevels.js';

const SB_BB = 0.5;
const BB_BB = 1;
/** これ未満の差は「一致」とみなし調整しない（表示丸め分は displayTolerance で別途上乗せ）。 */
const CONSISTENT_TOL = 0.05;
/**
 * BB 表示の刻み（画面は小数第1位まで＝ 73.5bb のように出る）。
 *
 * 実チップ → BB 換算は割り切れないので、画面の値は必ずこの刻みへ丸められている。
 * その丸め残差は 1 席あたり最大 ±DISPLAY_STEP/2 で、**席数に比例して合計に積み上がる**。
 * 総チップ保存の理論値（90,000÷BB）は丸める前の値なので、両者の差は誤読でなくても
 * 席数ぶんだけ開く。ここを見落として「差＝誤読」と決めつけると、正しく読めている
 * スタックを勝手に書き換えてしまう（β報告: 3人・BB=780 で 73.5bb が 73.6bb に化けた）。
 *
 * 丸めが切り捨てか四捨五入かは実測で確かめた（[[ocr-accuracy-verification]] の規律）。
 * 総チップが保存している GT フレーム 6 枚（n=2..6）の delta は **-0.086 〜 +0.050** に収まり、
 * 席数に比例して**両側**へ散った。切り捨てなら +0.05n 側へ偏るはずなので、実装は
 * **四捨五入**と判断し、許容幅も両側 ±0.05n とする。
 */
const DISPLAY_STEP = 0.1;
/** 差がこの割合（総BB比）を超えたら誤補正回避のため触らない（モード不一致等）。 */
const LARGE_DELTA_FRAC = 0.06;
/** スタック≈0（オールイン）とみなす閾値。 */
const ALLIN_STACK = 0.5;
/** オールイン時のポット照合許容差（BB）。計算ポット vs OCR ポット。 */
const POT_TOL = 0.2;

export type ChipCheckMode =
  | 'disabled' // blindChips 無し等でチェック無効
  | 'consistent' // 一致（調整不要）
  | 'recover' // 1 席復元
  | 'adjust' // 最低信頼席で差分調整
  | 'allin-consistent' // オールイン: 計算ポット＝OCR ポット（整合・計算値採用）
  | 'allin-pot-computed' // オールイン: OCR ポットが欠測/相違 → 計算値で採用
  | 'allin-bet-underread' // オールイン: 計算ポット<OCR（ベット読み落とし疑い）→ OCR 保持
  | 'allin-unread-skip' // オールイン: 当該席のベット未読でポット計算不可（保留）
  | 'multi-unreadable-skip' // 未読 2 席以上で一意に解けず
  | 'large-delta-skip'; // 差が大きすぎて未補正

export interface ChipConsistencyResult {
  readonly applied: boolean;
  readonly mode: ChipCheckMode;
  readonly totalBbTheory?: number;
  readonly totalBbRead?: number;
  readonly deltaBb?: number;
  /** 復元／調整した席 id（あれば）。 */
  readonly correctedSeatId?: string;
  /** オールイン時: 場のベット総和＋アンティから計算したポット（＝人数×アンティ+全ベット）。 */
  readonly potComputed?: number;
  /** OCR が読んだ中央ポット（照合用・参考）。 */
  readonly potRead?: number;
  /** オールイン時: 総チップ保存（90,000÷bb）が成立したか（クラブマッチのみ意味を持つフラグ）。 */
  readonly conserved?: boolean;
  readonly notes: readonly string[];
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** 表示スタックは必ず 0.1 刻み。復元・補正した値もその格子に載せる（画面と同じ形にする）。 */
function snapDisplay(x: number): number {
  return Math.round(x * 10) / 10;
}

/**
 * 「読み合計 vs 理論値」の許容差。表示丸めの残差が席数に比例して積み上がる分を上乗せする。
 * displayedCount は**画面から読んだスタックの個数**（丸め残差の発生源の数）。
 */
function displayTolerance(displayedCount: number): number {
  return CONSISTENT_TOL + (DISPLAY_STEP / 2) * displayedCount;
}

/** アンティ拠出（BB 換算）。scheme に応じて all=人数分 / bb=1 席分 / none=0。 */
function anteContribution(reads: RawReads, players: number, anteBb: number): number {
  if (reads.ante.scheme === 'all') return anteBb * players;
  if (reads.ante.scheme === 'bb') return anteBb;
  return 0;
}

/**
 * 総チップ保存チェックを適用し、必要なら 1 席のスタックを復元/調整した reads を返す。
 * 無効条件では reads をそのまま返す。
 */
export function applyChipConsistency(reads: RawReads): { reads: RawReads; result: ChipConsistencyResult } {
  const bc = reads.blindChips;
  if (!bc || !(bc.bb > 0) || (reads.displayMode && reads.displayMode !== 'bb')) {
    return { reads, result: { applied: false, mode: 'disabled', notes: [] } };
  }

  const occ = reads.seats.filter((s) => s.occupancy.value === 'occupied');
  const players = occ.length;
  if (players < 2) return { reads, result: { applied: false, mode: 'disabled', notes: ['players<2'] } };

  const totalBbTheory = totalBbFromBbChips(bc.bb); // 90,000 / bb
  const anteBb = bc.ante / bc.bb;
  const deadPot = anteContribution(reads, players, anteBb) + SB_BB + BB_BB;
  // オールイン無しのプリフロップ（＝受理対象の push/fold 局面）のポットはデッドポットに等しい。
  // OCR 中央ポットの読みでなく**計算値**を採用（さつき指摘: ポットは人数×アンティ+SB+BB で厳密）。
  const potFixed = { value: round2(deadPot), conf: 0.95 } as const;

  const allins = occ.filter((s) => Number.isFinite(s.stack.value) && s.stack.value < ALLIN_STACK);
  if (allins.length > 0) {
    // Phase 4: オールイン在席（さつき決定 2026-09-09）。
    // ポットは「デッドポット＋場のベット総和」＝ antePot + Σbets で厳密に計算できる
    //   （さつき: 0 がある場合 pot = 人数×アンティ + SB + BB + allin。SB/BB/allin はすべてベットとして
    //    場に出ているので Σbets に含まれる ⇒ pot = antePot + Σbets）。
    // これは**総チップ保存(90,000)に依存しない**のでモード非依存で妥当（実測 heads-up/3way のポットに
    // 厳密一致）。ただしベット読みが欠けると過小評価になるため、全オールイン席のベットが読めている
    // （>ALLIN_STACK）ことをゲートにする（未読なら従来どおり保留＝回帰ゼロ）。複数オールインも
    // Σbets がそのまま総額になるので同じ式で扱える（サイドポット分割は下流 reconstruction の責務）。
    const antePot = anteContribution(reads, players, anteBb);
    const betSum = round2(occ.reduce((a, s) => a + (Number.isFinite(s.bet.value) ? s.bet.value : 0), 0));
    const allAllinBetsRead = allins.every((s) => Number.isFinite(s.bet.value) && s.bet.value > ALLIN_STACK);
    if (!allAllinBetsRead) {
      return { reads, result: { applied: false, mode: 'allin-unread-skip', totalBbTheory, notes: ['all-in bet not read; cannot compute pot'] } };
    }
    const computedPot = round2(antePot + betSum);

    // ② 総チップ保存（クラブマッチのみ意味を持つ）。allChips = Σ(読めたスタック) + Σbets + antePot。
    //    自動補正は**しない**（非クラブ混入・中盤テーブルでは 90,000/bb に乗らず危険。検証フレームも無い）
    //    ＝フラグのみ。オールイン席のスタックは 0（既知）なので復元も不要。
    const stackSum = round2(occ.filter((s) => Number.isFinite(s.stack.value)).reduce((a, s) => a + s.stack.value, 0));
    const allChips = round2(stackSum + betSum + antePot);
    const conserved = Math.abs(allChips - totalBbTheory) <= LARGE_DELTA_FRAC * totalBbTheory;

    // ① ポット照合。計算値が OCR と整合 or OCR 欠測なら計算値を採用（さつき: 計算値を正）。
    //    計算値が OCR より明確に小さい＝ブラインド/他ベットの読み落とし疑い → OCR を保持（過補正回避）。
    const potRead = reads.pot.value;
    const potAgrees = Number.isFinite(potRead) && Math.abs(computedPot - potRead) <= POT_TOL;
    const potUnderReadRisk = Number.isFinite(potRead) && computedPot < potRead - POT_TOL;
    const notes: string[] = [];
    let outPot = reads.pot;
    let mode: ChipCheckMode;
    if (potUnderReadRisk) {
      mode = 'allin-bet-underread';
      notes.push(`computed pot ${computedPot} < OCR ${potRead}; bets likely under-read, keeping OCR pot`);
    } else {
      outPot = { value: computedPot, conf: 0.9 };
      mode = potAgrees ? 'allin-consistent' : 'allin-pot-computed';
      if (!potAgrees) notes.push(`OCR pot ${Number.isFinite(potRead) ? potRead : 'NaN'} → computed ${computedPot}`);
    }
    notes.push(
      conserved
        ? `chips conserved (all=${allChips}≈theory=${round2(totalBbTheory)})`
        : `chips NOT conserved (all=${allChips} vs theory=${round2(totalBbTheory)}); likely non-club/mid-table — no stack correction`,
    );
    return {
      reads: { ...reads, pot: outPot },
      result: {
        applied: mode !== 'allin-bet-underread',
        mode,
        totalBbTheory,
        totalBbRead: allChips,
        deltaBb: round2(totalBbTheory - allChips),
        potComputed: computedPot,
        ...(Number.isFinite(potRead) ? { potRead } : {}),
        conserved,
        notes,
      },
    };
  }

  const readable = occ.filter((s) => Number.isFinite(s.stack.value));
  const unreadable = occ.filter((s) => !Number.isFinite(s.stack.value));
  const readableSum = readable.reduce((a, s) => a + s.stack.value, 0);

  // 1 席だけ未読 → 保存則から復元。
  if (unreadable.length === 1) {
    // 復元値も画面と同じ 0.1 刻みに載せる（他席の丸め残差ぶん端数が乗るため）。
    const recovered = snapDisplay(totalBbTheory - (readableSum + deadPot));
    if (recovered > CONSISTENT_TOL && recovered < totalBbTheory) {
      const target = unreadable[0]!;
      const seats = reads.seats.map((s): RawSeatRead =>
        s.id === target.id ? { ...s, stack: { value: recovered, conf: 0.35 } } : s,
      );
      return {
        reads: { ...reads, seats, pot: potFixed },
        result: {
          applied: true, mode: 'recover', totalBbTheory, totalBbRead: totalBbTheory, deltaBb: 0,
          correctedSeatId: target.id, notes: [`recovered ${target.id}.stack=${recovered} from chip conservation`],
        },
      };
    }
    return { reads, result: { applied: false, mode: 'multi-unreadable-skip', totalBbTheory, notes: ['recovered value out of range'] } };
  }
  if (unreadable.length > 1) {
    return { reads, result: { applied: false, mode: 'multi-unreadable-skip', totalBbTheory, notes: [`${unreadable.length} unreadable stacks`] } };
  }

  // 全席読めた → 差分を最低信頼席で調整。
  const totalBbRead = round2(readableSum + deadPot);
  const delta = round2(totalBbTheory - totalBbRead);
  // 表示丸めで説明できる範囲は「一致」。ここを席数に比例させないと、正しい読みを補正してしまう。
  const tol = displayTolerance(readable.length);
  if (Math.abs(delta) <= tol) {
    return {
      reads: { ...reads, pot: potFixed },
      result: {
        applied: true, mode: 'consistent', totalBbTheory, totalBbRead, deltaBb: delta,
        notes: [`|delta|=${Math.abs(delta)} <= tol=${round2(tol)} (display rounding of ${readable.length} stacks)`],
      },
    };
  }
  if (Math.abs(delta) > LARGE_DELTA_FRAC * totalBbTheory) {
    return { reads, result: { applied: false, mode: 'large-delta-skip', totalBbTheory, totalBbRead, deltaBb: delta, notes: [`delta ${delta} too large; not adjusting`] } };
  }
  let target: RawSeatRead | undefined;
  for (const s of readable) if (!target || s.stack.conf < target.stack.conf) target = s;
  if (!target) return { reads, result: { applied: false, mode: 'large-delta-skip', totalBbTheory, totalBbRead, deltaBb: delta, notes: [] } };
  // 補正後の値も画面と同じ 0.1 刻みに載せる（表示され得ない端数を作らない）。
  const newVal = snapDisplay(target.stack.value + delta);
  if (newVal <= 0) {
    return { reads, result: { applied: false, mode: 'large-delta-skip', totalBbTheory, totalBbRead, deltaBb: delta, notes: ['adjustment would make stack<=0'] } };
  }
  const targetId = target.id;
  const seats = reads.seats.map((s): RawSeatRead =>
    s.id === targetId ? { ...s, stack: { value: newVal, conf: Math.min(s.stack.conf, 0.5) } } : s,
  );
  return {
    reads: { ...reads, seats, pot: potFixed },
    result: {
      applied: true, mode: 'adjust', totalBbTheory, totalBbRead, deltaBb: delta, correctedSeatId: targetId,
      notes: [`adjusted ${targetId}.stack by ${delta} (lowest-conf) to match chip total`],
    },
  };
}
