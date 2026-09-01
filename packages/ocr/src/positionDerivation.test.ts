import { describe, it, expect } from 'vitest';
import { positionsMatchPlayersLeft, type Position } from '@oshihiki/core';
import { derivePositions, clockwiseFromButton } from './positionDerivation.js';
import type { PhysicalSeat } from './types.js';

/** テスト用の席リング組み立てヘルパ。 */
function ring(
  specs: Array<{ occupied?: boolean; button?: boolean; hero?: boolean }>,
): PhysicalSeat[] {
  return specs.map((s, i) => ({
    id: `s${i}`,
    occupied: s.occupied ?? true,
    isButton: s.button ?? false,
    isHero: s.hero ?? false,
  }));
}

function posOf(r: ReturnType<typeof derivePositions>, id: string): Position | undefined {
  return r.ok ? r.byId.get(id) : undefined;
}

describe('clockwiseFromButton', () => {
  it('各人数で正規ポジション集合と一致する', () => {
    for (let n = 2; n <= 6; n++) {
      const set = clockwiseFromButton(n);
      expect(set.length).toBe(n);
      expect(positionsMatchPlayersLeft(set, n)).toBe(true);
    }
  });
  it('先頭は常にボタン席（HU は SB、それ以外は BU）', () => {
    expect(clockwiseFromButton(2)[0]).toBe('SB');
    for (let n = 3; n <= 6; n++) expect(clockwiseFromButton(n)[0]).toBe('BU');
  });
});

describe('derivePositions — 全席生存', () => {
  it('6 人: ボタン席から時計回りに [BU,SB,BB,UTG,HJ,CO]', () => {
    const r = derivePositions(
      ring([{ button: true }, {}, {}, { hero: true }, {}, {}]),
    );
    expect(r.ok).toBe(true);
    expect(posOf(r, 's0')).toBe('BU');
    expect(posOf(r, 's1')).toBe('SB');
    expect(posOf(r, 's2')).toBe('BB');
    expect(posOf(r, 's3')).toBe('UTG');
    expect(posOf(r, 's4')).toBe('HJ');
    expect(posOf(r, 's5')).toBe('CO');
    if (r.ok) {
      expect(r.heroPos).toBe('UTG');
      expect(r.playersLeft).toBe(6);
    }
  });

  it('ボタン位置が変わっても割り当ては一貫（回転不変）', () => {
    // ボタンを index 2 に。時計回り: s2=BU, s3=SB, s4=BB, s5=UTG, s0=HJ, s1=CO
    const r = derivePositions(
      ring([{}, {}, { button: true }, {}, {}, { hero: true }]),
    );
    expect(posOf(r, 's2')).toBe('BU');
    expect(posOf(r, 's3')).toBe('SB');
    expect(posOf(r, 's4')).toBe('BB');
    expect(posOf(r, 's5')).toBe('UTG');
    expect(posOf(r, 's0')).toBe('HJ');
    expect(posOf(r, 's1')).toBe('CO');
    if (r.ok) expect(r.heroPos).toBe('UTG');
  });
});

describe('derivePositions — HU（SB=BTN）', () => {
  it('生存 2 人はボタン席が SB、次が BB', () => {
    const r = derivePositions(ring([{ button: true, hero: true }, {}]));
    expect(r.ok).toBe(true);
    expect(posOf(r, 's0')).toBe('SB');
    expect(posOf(r, 's1')).toBe('BB');
    if (r.ok) {
      expect(r.heroPos).toBe('SB');
      expect(r.playersLeft).toBe(2);
    }
  });
});

describe('derivePositions — empty 席を飛ばす', () => {
  it('6 席中 2 席 empty → 生存 4 人としてポジション割り当て', () => {
    // 物理: s0=BTN, s1=empty, s2=live, s3=empty, s4=live(hero), s5=live
    const r = derivePositions(
      ring([
        { button: true },
        { occupied: false },
        {},
        { occupied: false },
        { hero: true },
        {},
      ]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.playersLeft).toBe(4);
    // clockwiseFromButton(4) = [BU, SB, BB, CO]、occupied 席へ順に
    expect(r.byId.get('s0')).toBe('BU');
    expect(r.byId.get('s2')).toBe('SB');
    expect(r.byId.get('s4')).toBe('BB');
    expect(r.byId.get('s5')).toBe('CO');
    // empty 席は含まれない
    expect(r.byId.has('s1')).toBe(false);
    expect(r.byId.has('s3')).toBe(false);
    expect(r.heroPos).toBe('BB');
  });

  it('生存席の集合は必ず正規ポジション集合に一致', () => {
    const r = derivePositions(
      ring([{ button: true }, { occupied: false }, {}, {}, { hero: true }]),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(positionsMatchPlayersLeft([...r.byId.values()], r.playersLeft)).toBe(true);
  });
});

describe('derivePositions — エラー系', () => {
  it('ボタン無し', () => {
    const r = derivePositions(ring([{ hero: true }, {}]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join()).toMatch(/ボタン/);
  });
  it('ボタンが empty 席に載っている', () => {
    const r = derivePositions(
      ring([{ occupied: false, button: true }, { hero: true }, {}]),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join()).toMatch(/empty/);
  });
  it('hero が居ない', () => {
    const r = derivePositions(ring([{ button: true }, {}]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join()).toMatch(/hero/);
  });
  it('ボタンが複数', () => {
    const r = derivePositions(
      ring([{ button: true, hero: true }, { button: true }]),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join()).toMatch(/複数/);
  });
});
