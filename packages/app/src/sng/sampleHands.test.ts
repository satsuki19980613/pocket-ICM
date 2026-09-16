/**
 * `buildSngSamples`（純関数）だけをテストする。IndexedDB は Node に無いので
 * `insertSngSamples`/`removeSngSamples` はテストしない（`historyStore.ts` にテストが
 * 無いのと同じ理由）。いちばん大事なのは各ハンドを decode→`sngIcmSpot` に掛けたときの
 * 判定が、動作確認したい 6 パターン（対象外 4 種＋対象 2 件）と一致することと、
 * decode/encode のラウンドトリップが崩れていないこと。
 */
import { decodeHand, encodeHand, type HandMeta } from '@oshihiki/sng';
import { describe, expect, it } from 'vitest';

import type { IcmSpotReason } from '../history/icmSpot';
import { sngIcmSpot } from '../history/icmSpot';
import { buildSngSamples, SAMPLE_GAME_ID } from './sampleHands';

const NOW = Date.UTC(2026, 8, 16, 20, 0, 0);

type Expectation =
  | { readonly ok: false; readonly reason: IcmSpotReason }
  | { readonly ok: true; readonly heroPos: string; readonly heroHand: string; readonly playersLeft: number };

const EXPECTED: Readonly<Record<number, Expectation>> = {
  1: { ok: false, reason: 'hero-deep' },
  5: { ok: false, reason: 'preflop-action' },
  8: { ok: false, reason: 'no-decision' },
  10: { ok: false, reason: 'no-cards' },
  12: { ok: true, heroPos: 'BU', heroHand: 'AKo', playersLeft: 6 },
  20: { ok: true, heroPos: 'SB', heroHand: 'QQ', playersLeft: 3 },
};

describe('buildSngSamples', () => {
  const { game, hands } = buildSngSamples(NOW);

  it('6件、gameId はサンプル用の固定 ID、handNo は 1/5/8/10/12/20', () => {
    expect(hands).toHaveLength(6);
    expect(hands.map((h) => h.handNo)).toEqual([1, 5, 8, 10, 12, 20]);
    expect(hands.every((h) => h.gameId === SAMPLE_GAME_ID)).toBe(true);
    expect(hands.every((h) => h.mySeat === 0)).toBe(true);
    expect(game.gameId).toBe(SAMPLE_GAME_ID);
  });

  it.each(hands.map((h) => [h.handNo, h] as const))('#%i: decode→sngIcmSpot の判定とラウンドトリップ', (handNo, h) => {
    const meta: HandMeta = { gameId: h.gameId, handNo: h.handNo, playedAt: h.playedAt, sb: h.sb, bb: h.bb, ante: h.ante };
    const decoded = decodeHand(h.encoded, meta);
    expect(decoded).not.toBeNull();
    if (!decoded) return;

    // ラウンドトリップ: decode したものをもう一度 encode→decode しても同じ値になる。
    const roundTripped = decodeHand(encodeHand(decoded), meta);
    expect(roundTripped).toEqual(decoded);

    const result = sngIcmSpot({ rec: decoded, game, mySeat: h.mySeat, myCards: h.myCards });
    const exp = EXPECTED[handNo];
    expect(exp).toBeDefined();
    if (!exp) return;

    expect(result.ok).toBe(exp.ok);
    if (result.ok && exp.ok) {
      expect(result.heroPos).toBe(exp.heroPos);
      expect(result.heroHand).toBe(exp.heroHand);
      expect(result.playersLeft).toBe(exp.playersLeft);
    } else if (!result.ok && !exp.ok) {
      expect(result.reason).toBe(exp.reason);
    }
  });
});
