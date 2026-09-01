import { describe, it, expect } from 'vitest';
import { parseBoardState, checkBoardStateSemantics, potChecksumDelta } from '@oshihiki/core';
import { SAMPLE_SPOTS } from '../src/sampleSpots';

// 3-1a のサンプル盤面が §3.1 スキーマ・意味論・ポット検算を満たすことを担保する
// （手入力フォーム 3-1b が生成すべき BoardState の妥当性の最小回帰）。
describe('sampleSpots — §3.1 BoardState として妥当', () => {
  for (const spot of SAMPLE_SPOTS) {
    it(`${spot.label}: zod parse + 意味論 + ポット検算を通る`, () => {
      const parsed = parseBoardState(spot.state);
      expect(parsed.ok, parsed.issues.join('; ')).toBe(true);
      const value = parsed.value!;
      expect(value.playersLeft).toBe(spot.state.playersLeft);

      const sem = checkBoardStateSemantics(value);
      expect(sem.ok, sem.issues.join('; ')).toBe(true);

      // ポット・チェックサム一致（差 ≈ 0）。
      const delta = potChecksumDelta(value);
      expect(delta).not.toBeNull();
      expect(Math.abs(delta!)).toBeLessThan(1e-9);

      // hero は先頭（オープン）ポジションで live。
      const heroSeat = value.seats.find((s) => s.pos === value.heroPos);
      expect(heroSeat?.state).toBe('live');
    });
  }
});
