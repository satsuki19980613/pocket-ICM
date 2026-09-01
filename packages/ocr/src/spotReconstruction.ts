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
import type { RawReads, RawSeatRead } from './types.js';
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
  readonly folded: boolean;
  readonly allin: boolean;
  readonly screenStack: number;
  readonly screenBet: number;
  readonly blindOb: number;
}

/**
 * push/fold で扱えない盤面を検出する（§6.5）。
 * - 非オールインの自発的コミット（voluntary = screenBet - blindOb > 0）→ リンプ/レイズ/3bet
 * - hero が BB で pot 未レイズ（誰もオールイン/自発コミットしていない）→ ウォーク（no decision）
 */
export function detectOutOfScope(facts: readonly SeatFacts[], heroPos: Position): string[] {
  const issues: string[] = [];

  for (const f of facts) {
    if (f.folded) continue; // フォールド済みはブラインドのデッド分のみ、判定対象外
    const voluntary = f.screenBet - f.blindOb;
    if (!f.allin && voluntary > EPS) {
      issues.push(
        `${f.pos} が非オールインで ${voluntary.toFixed(2)}bb を追加投入しています` +
          `（リンプ/ミニレイズ/3bet は push/fold では扱えません）`,
      );
    }
  }

  const contested = facts.some(
    (f) => !f.isHero && !f.folded && (f.allin || f.screenBet - f.blindOb > EPS),
  );
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
    occupied: s.presence.value !== 'empty',
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
    const folded = raw.presence.value === 'folded';
    const allin = raw.allin.value;
    const screenStack = raw.stack.value;
    const screenBet = raw.bet.value;
    const blindOb = blindObligation(pos, sb, bb);

    facts.push({ id, pos, isHero: raw.isHero, folded, allin, screenStack, screenBet, blindOb });

    const putIn = folded ? blindOb : screenBet;
    const fullBehind = screenStack + putIn;
    const rootStack = fullBehind - blindOb;

    rootSeats.push({
      pos,
      stack: rootStack,
      bet: blindOb,
      state: 'live',
      confidence: {
        stack: raw.stack.conf,
        bet: raw.bet.conf,
        state: raw.presence.conf,
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
