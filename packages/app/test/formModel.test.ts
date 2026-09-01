import { describe, it, expect } from 'vitest';
import { buildBoardState, defaultForm, reconcilePositions, type BoardForm } from '../src/formModel';

// 手入力フォーム → BoardState 組み立て・検証（3-1b）の回帰テスト。
describe('formModel.buildBoardState', () => {
  it('既定フォーム（5人）は妥当な BoardState を作り、ポット検算が一致する', () => {
    const r = buildBoardState(defaultForm(5));
    expect(r.ok, r.issues.join('; ')).toBe(true);
    expect(r.state?.playersLeft).toBe(5);
    expect(r.state?.heroPos).toBe('UTG');
    // SB/BB にブラインドの bet が入る。
    const sb = r.state!.seats.find((s) => s.pos === 'SB')!;
    const bb = r.state!.seats.find((s) => s.pos === 'BB')!;
    expect(sb.bet).toBe(0.5);
    expect(bb.bet).toBe(1);
    expect(r.potDelta).not.toBeNull();
    expect(Math.abs(r.potDelta!)).toBeLessThan(1e-9);
  });

  it('全人数（2..6）で妥当', () => {
    for (const n of [2, 3, 4, 5, 6]) {
      const r = buildBoardState(defaultForm(n));
      expect(r.ok, `${n}: ${r.issues.join('; ')}`).toBe(true);
      expect(r.state?.seats).toHaveLength(n);
    }
  });

  it('SB >= BB は無効', () => {
    const f: BoardForm = { ...defaultForm(3), sb: '2', bb: '1' };
    const r = buildBoardState(f);
    expect(r.ok).toBe(false);
    expect(r.issues.some((m) => m.includes('SB'))).toBe(true);
  });

  it('不正な hero ハンドは無効', () => {
    const f: BoardForm = { ...defaultForm(3), heroHand: 'ZZ' };
    const r = buildBoardState(f);
    expect(r.ok).toBe(false);
    expect(r.issues.some((m) => m.includes('ハンド'))).toBe(true);
  });

  it('スタック非正は無効', () => {
    const f = defaultForm(4);
    const r = buildBoardState({ ...f, stacks: { ...f.stacks, BU: '0' } });
    expect(r.ok).toBe(false);
    expect(r.issues.some((m) => m.includes('BU'))).toBe(true);
  });

  it('ante all はポット検算にアンティ寄与を含めて一致する', () => {
    const f: BoardForm = { ...defaultForm(5), anteScheme: 'all', anteAmount: '0.25' };
    const r = buildBoardState(f);
    expect(r.ok, r.issues.join('; ')).toBe(true);
    expect(Math.abs(r.potDelta!)).toBeLessThan(1e-9);
    expect(r.state?.ante).toEqual({ scheme: 'all', amount: 0.25 });
  });

  it('reconcilePositions は人数変更時にスタック/heroPos を整える', () => {
    const f5 = defaultForm(5); // hero UTG
    const f3 = reconcilePositions({ ...f5, playersLeft: 3 });
    // 3人にはUTGが無い → heroPos は先頭(BU)へ。
    expect(f3.heroPos).toBe('BU');
    expect(Object.keys(f3.stacks).sort()).toEqual(['BB', 'BU', 'SB']);
  });
});
