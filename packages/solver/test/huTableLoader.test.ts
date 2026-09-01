import { describe, it, expect } from 'vitest';
import { loadHuTable, huTableArtifactExists } from '../src/huTableLoader.js';
import { HAND_CLASS_ORDER } from '../src/huEquity.js';

// 成果物が未生成の環境ではスキップ（`npm run gen:hu-equity` で生成）。
const has = huTableArtifactExists();

describe.skipIf(!has)('同梱 HU equity テーブルの読み込み', () => {
  it('169×169・順序が core と一致', () => {
    const t = loadHuTable();
    expect(t.dims).toBe(169);
    expect(t.equity.length).toBe(169 * 169);
    expect(t.order).toEqual(HAND_CLASS_ORDER);
  });

  it('既知値がテーブルに入っている', () => {
    const t = loadHuTable();
    expect(t.get('AA', 'KK')).toBeGreaterThan(0.815);
    expect(t.get('AA', 'KK')).toBeLessThan(0.825);
    expect(t.get('72o', 'AA')).toBeGreaterThan(0.1);
    expect(t.get('72o', 'AA')).toBeLessThan(0.14);
  });

  it('零和性: get(A,B) + get(B,A) ≈ 1（f32 丸め許容）', () => {
    const t = loadHuTable();
    expect(t.get('AKs', 'QQ') + t.get('QQ', 'AKs')).toBeCloseTo(1, 5);
    expect(t.get('JTs', '99') + t.get('99', 'JTs')).toBeCloseTo(1, 5);
  });

  it('対角は 0.5', () => {
    const t = loadHuTable();
    expect(t.get('AA', 'AA')).toBeCloseTo(0.5, 6);
    expect(t.get('72o', '72o')).toBeCloseTo(0.5, 6);
  });
});
