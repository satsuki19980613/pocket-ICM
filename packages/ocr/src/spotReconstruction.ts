/**
 * 画面の実ベット → root push/fold spot への復元（Plan 2-6 / SPEC §6.4-6.5）。
 *
 * solver は「全席 live・ブラインド投函済み・未開」の root を全木で解く
 * （nwaySolver: T = stack + bet + antePaid、state !== 'empty' の席のみ対象）。
 * 誰が既にフォールド/シューブしたかは結果画面のノード選択で扱う。したがって
 * OCR は画面の途中状態から root を逆算する:
 *
 *   fullBehind_i = screenStack_i + putIn_i          （ante は solver が別途加算）
 *   putIn_i      = folded ? 席のブラインド義務 : screenBet_i
 *   rootStack_i  = fullBehind_i - blindOb_i
 *   rootBet_i    = blindOb_i          （SB=sb, BB=bb, それ以外 0）
 *
 * これにより、シューブ済み席（screenStack=0, screenBet=全額）もフォールド済み席も
 * 「配られた時点の持ち込み」に戻り、solver が root から解ける。
 *
 * push/fold Nash はフォールドとオールインしか持たない。よって非オールインの
 * 自発的コミット（リンプ・ミニレイズ・3bet 等）を検出したら対象外エラーとする（§6.5）。
 */

import type { BoardState, Position, Seat } from '@oshihiki/core';
import type { RawReads, RawSeatRead, SeatAction } from './types.js';
import { derivePositions } from './positionDerivation.js';
import type { PhysicalSeat } from './types.js';

const EPS = 1e-6;

function blindObligation(pos: Position, sb: number, bb: number): number {
  if (pos === 'SB') return sb;
  if (pos === 'BB') return bb;
  return 0;
}

/** 対象外検出（§6.5）。1 席ぶんの正規化事実。 */
export interface SeatFacts {
  /** 物理席 id（RawSeatRead との対応用）。 */
  readonly id: string;
  readonly pos: Position;
  readonly isHero: boolean;
  /** リプレイの行動ラベル（状態復元の主信号）。 */
  readonly action: SeatAction;
  readonly folded: boolean;
  readonly allin: boolean;
  readonly screenStack: number;
  readonly screenBet: number;
  readonly blindOb: number;
}

/**
 * push/fold で扱えない盤面を検出する（§6.5）。**行動ラベル駆動**。
 *
 * push/fold Nash はフォールドとオールインのみ。有効な終了フレームのラベルは
 *   fold / allin / call（ただしオールインが場にある場合のみ）/ check（BB のみ）
 * に限られる。
 * - raise（非オールインのオープン/ミニレイズ/3bet）→ 対象外
 * - call だがオールインが場に無い → リンプ（BB コール）や非オールインへのコール → 対象外
 * - hero が BB でオールイン・レイズ・リンプのいずれも無い → ウォーク（no decision）
 *
 * ベット額はラベルと矛盾する場合の補助チェックに使う（ラベルが主）。
 */
export function detectOutOfScope(facts: readonly SeatFacts[], heroPos: Position): string[] {
  const issues: string[] = [];
  const anyAllin = facts.some((f) => f.action === 'allin');

  for (const f of facts) {
    if (f.action === 'raise') {
      issues.push(`${f.pos} がレイズ（非オールイン）しています（ミニレイズ/オープン/3bet は push/fold では扱えません）`);
    } else if (f.action === 'call' && !anyAllin) {
      issues.push(`${f.pos} がコール（リンプ/非オールインへのコール）しています（push/fold では扱えません）`);
    } else if (f.action === 'none' && !f.folded) {
      // ラベルが無いのにベットが blind を超える＝読み落とし or 非対応アクション
      const voluntary = f.screenBet - f.blindOb;
      if (voluntary > EPS) {
        issues.push(`${f.pos} に未分類のベット ${voluntary.toFixed(2)}bb があります（要手入力確認）`);
      }
    }
  }

  const contested = facts.some((f) => !f.isHero && (f.action === 'allin' || f.action === 'raise' || f.action === 'call'));
  if (heroPos === 'BB' && !contested) {
    issues.push('hero が BB で pot が未レイズです（ウォーク＝判断が存在しないため対象外）');
  }

  return issues;
}

export interface ReconstructResult {
  readonly ok: boolean;
  readonly issues: string[];
  /** 成功時の root spot（solver 入力）。 */
  readonly state?: BoardState;
  /** 表示用の実プレゼンス（条件確認画面のため）。key は pos。 */
  readonly facts?: ReadonlyMap<Position, SeatFacts>;
}

/**
 * RawReads → root BoardState 復元 ＋ 対象外検出。
 * zod 検証は呼び出し側（pipeline / core.parseBoardState）で行う。
 */
export function reconstructSpot(reads: RawReads): ReconstructResult {
  const issues: string[] = [];
  const sb = reads.blinds.sb.value;
  const bb = reads.blinds.bb.value;

  const ring: PhysicalSeat[] = reads.seats.map((s) => ({
    id: s.id,
    occupied: s.occupancy.value !== 'empty',
    isButton: s.isButton,
    isHero: s.isHero,
  }));

  const derived = derivePositions(ring);
  if (!derived.ok) return { ok: false, issues: derived.issues };

  const bySeatId = new Map<string, RawSeatRead>(reads.seats.map((s) => [s.id, s]));

  const facts: SeatFacts[] = [];
  const rootSeats: Seat[] = [];
  for (const [id, pos] of derived.byId) {
    const raw = bySeatId.get(id)!;
    const action: SeatAction = raw.action.value;
    const folded = action === 'fold';
    const allin = action === 'allin';
    const screenStack = raw.stack.value;
    const screenBet = raw.bet.value;
    const blindOb = blindObligation(pos, sb, bb);

    facts.push({ id, pos, isHero: raw.isHero, action, folded, allin, screenStack, screenBet, blindOb });

    // root への逆算: フォールド済みはブラインドのデッド分のみを putIn とみなす。
    const putIn = folded ? blindOb : screenBet;
    // 占有は検出できたがスタック数字が読めない席（seatPresence のみで occupied）: root 復元に
    // 使える数値が無い。ここで席を落とすと 6-max が 5-max として黙って誤解される（本バグ）。
    // 代わりに 0 を仮置きして席を残し（人数は正しい）、raw.stack.conf(=0) 由来で
    // lowConfidenceFields に `${pos}.stack` が載る（確認画面で手入力）。zod は finite/nonnegative を
    // 要求するので NaN は渡せない。※solver へは仮値 0 が入るため確認画面での修正が前提（§6.1 プリフィル）。
    const stackFinite = Number.isFinite(screenStack);
    const fullBehind = (stackFinite ? screenStack : 0) + putIn;
    const rootStack = stackFinite ? fullBehind - blindOb : Math.max(0, fullBehind - blindOb);

    rootSeats.push({
      pos,
      stack: rootStack,
      bet: blindOb,
      state: 'live',
      confidence: {
        stack: raw.stack.conf,
        bet: raw.bet.conf,
        state: Math.min(raw.occupancy.conf, raw.action.conf),
      },
    });
  }

  issues.push(...detectOutOfScope(facts, derived.heroPos));
  if (issues.length > 0) return { ok: false, issues };

  const anteAmount = reads.ante.scheme === 'none' ? 0 : reads.ante.amount.value;

  const state: BoardState = {
    street: 'preflop',
    blinds: { sb, bb },
    ante: { scheme: reads.ante.scheme, amount: anteAmount },
    heroHand: reads.heroHand.value,
    playersLeft: derived.playersLeft,
    seats: rootSeats,
    heroPos: derived.heroPos,
    // pot は画面の実読み取り値を保持（solver は pot を使わない）。root の理論ベット和とは
    // 別物なので、チェックサム（confidence.ts）で screen 値どうしを突き合わせる。
    pot: reads.pot.value,
    heroHandConfidence: reads.heroHand.conf,
  };

  const factsMap = new Map<Position, SeatFacts>(facts.map((f) => [f.pos, f]));
  return { ok: true, issues: [], state, facts: factsMap };
}
