import { describe, it, expect } from 'vitest';
import { exactEquityVsHands, handClassToCombos, classVsClassEquityExact } from '../src/huEquity.js';
import { classEquityCanonical } from '../src/huTable.js';
import { parseCard } from '../src/evaluator.js';

const c = (s: string) => parseCard(s);
const T = 60_000; // 盤面全列挙は 1 マッチアップ ~0.3s。余裕をもたせる。

describe('handClassToCombos', () => {
  it('生成コンボ数（ペア6・スーテッド4・オフスート12）', () => {
    expect(handClassToCombos('AA').length).toBe(6);
    expect(handClassToCombos('AKs').length).toBe(4);
    expect(handClassToCombos('AKo').length).toBe(12);
  });
  it('スーテッドは同 suit、オフスートは異 suit', () => {
    for (const [a, b] of handClassToCombos('AKs')) expect((a & 3) === (b & 3)).toBe(true);
    for (const [a, b] of handClassToCombos('AKo')) expect((a & 3) !== (b & 3)).toBe(true);
  });
});

describe('既知の HU 勝率（厳密全列挙）', () => {
  it('AA vs KK（特定 suit, 非共有）≒ 82.6%', () => {
    const r = exactEquityVsHands([c('Ah'), c('As')], [c('Kh'), c('Ks')]);
    expect(r.total).toBe(1712304); // C(48,5)
    expect(r.equity).toBeCloseTo(0.8264, 2);
  }, T);

  it('72o vs AA ≒ 11.8%', () => {
    const r = exactEquityVsHands([c('7h'), c('2c')], [c('Ah'), c('As')]);
    expect(r.equity).toBeGreaterThan(0.108);
    expect(r.equity).toBeLessThan(0.128);
  }, T);

  it('相補性: equity(A vs B) + equity(B vs A) = 1', () => {
    const ab = exactEquityVsHands([c('Ah'), c('Ks')], [c('Qh'), c('Qd')]);
    const ba = exactEquityVsHands([c('Qh'), c('Qd')], [c('Ah'), c('Ks')]);
    expect(ab.equity + ba.equity).toBeCloseTo(1, 10);
  }, T);

  it('鏡像対称: KK vs KK（別 suit）= 0.5 ちょうど', () => {
    const r = exactEquityVsHands([c('Kh'), c('Ks')], [c('Kd'), c('Kc')]);
    expect(r.equity).toBeCloseTo(0.5, 10);
  }, T);
});

describe('クラス平均 equity（正規化削減, チャート値と一致）', () => {
  it('AA vs KK ≒ 81.95%（クラス平均）', () => {
    expect(classEquityCanonical('AA', 'KK')).toBeCloseTo(0.8195, 3);
  }, T);

  it('AKs vs QQ ≒ 46.0%', () => {
    expect(classEquityCanonical('AKs', 'QQ')).toBeCloseTo(0.4605, 2);
  }, T);

  it('AKo vs QQ ≒ 43.2%', () => {
    expect(classEquityCanonical('AKo', 'QQ')).toBeCloseTo(0.432, 2);
  }, T);

  it('AA vs 22 ≒ 82.2%', () => {
    const v = classEquityCanonical('AA', '22');
    expect(v).toBeGreaterThan(0.815);
    expect(v).toBeLessThan(0.83);
  }, T);

  it('クラス平均も相補的', () => {
    const ab = classEquityCanonical('JTs', '99');
    const ba = classEquityCanonical('99', 'JTs');
    expect(ab + ba).toBeCloseTo(1, 9);
  }, T);
});

describe('正規化削減の厳密性（canon == 全コンボ平均）', () => {
  it('KQs vs 22 で一致', () => {
    const canon = classEquityCanonical('KQs', '22');
    const full = classVsClassEquityExact('KQs', '22');
    expect(canon).toBeCloseTo(full, 12);
  }, T);
});
