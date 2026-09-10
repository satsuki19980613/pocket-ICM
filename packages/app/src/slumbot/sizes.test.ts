import { describe, expect, it } from 'vitest';

import { legalActions, parseAction, potOf, type HandState } from './rules';
import {
  DEFAULT_BET_SIZES,
  MAX_PRESETS,
  addPreset,
  allInBetTo,
  categoryOf,
  clampBetTo,
  loadBetSizes,
  removePreset,
  resetCategory,
  resolvePreset,
  saveBetSizes,
  snapBetTo,
  stepBetTo,
  type BetSizeConfig,
} from './sizes';

function st(action: string): HandState {
  const r = parseAction(action);
  if (!r.ok) throw new Error(r.error);
  return r.state;
}

describe('categoryOf', () => {
  it('プリフロップは「レイズが入っているか」で分かれる（BB は既にベット扱い）', () => {
    expect(categoryOf(st(''))).toBe('pfOpen');
    expect(categoryOf(st('b200'))).toBe('pfVsRaise');
  });

  it('ポストフロップは「ベットを受けているか」で分かれる', () => {
    expect(categoryOf(st('b200c/'))).toBe('postBet');
    expect(categoryOf(st('b200c/b500'))).toBe('postVsBet');
  });
});

describe('resolvePreset', () => {
  it('プリフロップの bb 指定はそのままの額（2.3bb → 230）', () => {
    const s = st('');
    expect(resolvePreset({ unit: 'bb', value: 2 }, s)).toBe(200);
    expect(resolvePreset({ unit: 'bb', value: 2.3 }, s)).toBe(230);
    expect(resolvePreset({ unit: 'bb', value: 5 }, s)).toBe(500);
  });

  it('vs レイズの x 指定は相手のレイズ額の倍率（3x vs 200 → 600）', () => {
    const s = st('b200');
    expect(resolvePreset({ unit: 'x', value: 3 }, s)).toBe(600);
    expect(resolvePreset({ unit: 'x', value: 2.5 }, s)).toBe(500);
  });

  it('ポストフロップの % はポット比（ポット 400 の 75% → 300）', () => {
    const s = st('b200c/');
    expect(potOf(s)).toBe(400);
    expect(resolvePreset({ unit: 'pct', value: 75 }, s)).toBe(300);
    expect(resolvePreset({ unit: 'pct', value: 100 }, s)).toBe(400);
  });

  it('小さすぎる % はミニマムベット（1bb）へ引き上げられる', () => {
    const s = st('b200c/');
    // 400 の 10% = 40 だが、ポストフロップの最小ベットは BB=100。
    expect(resolvePreset({ unit: 'pct', value: 10 }, s)).toBe(100);
  });

  it('レイズの % は「コール後のポット」への上乗せ（100% = ポットレイズ）', () => {
    // フロップ ポット 400、相手が 300 ベット → コールすると 400+300+300=1000。
    // 100% レイズ = 相手の 300 に 1000 を足して 1300 まで。
    const s = st('b200c/b300');
    expect(resolvePreset({ unit: 'pct', value: 100 }, s)).toBe(1300);
    expect(resolvePreset({ unit: 'pct', value: 50 }, s)).toBe(300 + 500);
  });

  it('ポストフロップの vs ベットでも x は相手のベット額の倍率', () => {
    const s = st('b200c/b300');
    expect(resolvePreset({ unit: 'x', value: 2 }, s)).toBe(600);
    expect(resolvePreset({ unit: 'x', value: 5 }, s)).toBe(1500);
  });

  it('大きすぎる指定はオールインで頭打ち', () => {
    const s = st('b200c/');
    expect(allInBetTo(s)).toBe(19800);
    expect(resolvePreset({ unit: 'pct', value: 2000 }, s)).toBe(8000); // まだ収まる
    expect(resolvePreset({ unit: 'pct', value: 9000 }, s)).toBe(legalActions(s).maxBetTo);
    expect(resolvePreset({ unit: 'bb', value: 500 }, s)).toBe(19800);
  });
});

describe('clamp / snap / step', () => {
  const s = st('b200c/'); // フロップ・ポット 400・ベット可能域 100〜19800

  it('clampBetTo は合法域に丸める', () => {
    expect(clampBetTo(50, s)).toBe(100);
    expect(clampBetTo(999999, s)).toBe(19800);
    expect(clampBetTo(555, s)).toBe(555);
  });

  it('snapBetTo は調整単位の目盛りに吸着する', () => {
    expect(snapBetTo(555, s, 1)).toBe(600); // 1bb 刻み
    expect(snapBetTo(555, s, 0.5)).toBe(550);
    expect(snapBetTo(534, s, 0.1)).toBe(530);
  });

  it('端は目盛りから外れていてもそのまま選べる（ミニマム・オールイン）', () => {
    const r = st('b200c/b350'); // 最小レイズ 700・上限 19800
    expect(legalActions(r).minBetTo).toBe(700);
    expect(snapBetTo(10, r, 5)).toBe(700);
    expect(snapBetTo(99999, r, 5)).toBe(19800);
  });

  it('stepBetTo は 1 目盛りずつ動き、端を越えない', () => {
    expect(stepBetTo(600, s, 1, 1)).toBe(700);
    expect(stepBetTo(600, s, 1, -1)).toBe(500);
    expect(stepBetTo(100, s, 1, -1)).toBe(100);
    expect(stepBetTo(19800, s, 1, 1)).toBe(19800);
    // 目盛りから外れた値からは、まず目盛りに乗ってから動く。
    expect(stepBetTo(555, s, 1, 1)).toBe(700);
  });
});

describe('プリセットの編集', () => {
  it('追加すると単位ごとにまとまって昇順に並ぶ', () => {
    const r = addPreset(DEFAULT_BET_SIZES, 'pfOpen', 'bb', 2.2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.pfOpen.map((p) => p.value)).toEqual([2, 2.2, 2.3, 2.5, 3, 4, 5]);
  });

  it('上限ちょうどの値は登録できる', () => {
    expect(addPreset(DEFAULT_BET_SIZES, 'pfOpen', 'bb', 200).ok).toBe(true);
    expect(addPreset(DEFAULT_BET_SIZES, 'postBet', 'pct', 2000).ok).toBe(true);
    expect(addPreset(DEFAULT_BET_SIZES, 'pfVsRaise', 'x', 100).ok).toBe(true);
    expect(addPreset(DEFAULT_BET_SIZES, 'pfOpen', 'bb', 200.01).ok).toBe(false);
  });

  it('重複・0以下・使えない単位は弾く', () => {
    expect(addPreset(DEFAULT_BET_SIZES, 'pfOpen', 'bb', 2).ok).toBe(false);
    expect(addPreset(DEFAULT_BET_SIZES, 'pfOpen', 'bb', 0).ok).toBe(false);
    expect(addPreset(DEFAULT_BET_SIZES, 'pfOpen', 'pct', 50).ok).toBe(false);
  });

  it('15 個を超えては追加できない', () => {
    let cfg: BetSizeConfig = { ...DEFAULT_BET_SIZES, postBet: [] };
    for (let i = 1; i <= MAX_PRESETS; i += 1) {
      const r = addPreset(cfg, 'postBet', 'pct', i);
      expect(r.ok).toBe(true);
      if (r.ok) cfg = r.config;
    }
    expect(cfg.postBet).toHaveLength(MAX_PRESETS);
    const over = addPreset(cfg, 'postBet', 'pct', 999);
    expect(over.ok).toBe(false);
  });

  it('削除とカテゴリ単位のリセット', () => {
    const removed = removePreset(DEFAULT_BET_SIZES, 'pfOpen', 0);
    expect(removed.pfOpen.map((p) => p.value)).toEqual([2.3, 2.5, 3, 4, 5]);
    expect(resetCategory(removed, 'pfOpen').pfOpen).toEqual(DEFAULT_BET_SIZES.pfOpen);
    // 他のカテゴリは触らない。
    expect(removed.postBet).toEqual(DEFAULT_BET_SIZES.postBet);
  });
});

describe('保存と読み込み', () => {
  function memoryStore(): Storage {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
      key: () => null,
      get length() {
        return map.size;
      },
    } as unknown as Storage;
  }

  it('往復して同じ設定が戻る', () => {
    const store = memoryStore();
    const cfg: BetSizeConfig = { ...DEFAULT_BET_SIZES, handleUnit: 0.5, pfOpen: [{ unit: 'bb', value: 2.75 }] };
    saveBetSizes(store, cfg);
    expect(loadBetSizes(store)).toEqual(cfg);
  });

  it('未保存・壊れた値は既定へ落ちる', () => {
    expect(loadBetSizes(null)).toEqual(DEFAULT_BET_SIZES);
    expect(loadBetSizes(memoryStore())).toEqual(DEFAULT_BET_SIZES);
    const broken = memoryStore();
    broken.setItem('icm.slumbot.betSizes.v1', '{{{');
    expect(loadBetSizes(broken)).toEqual(DEFAULT_BET_SIZES);
  });
});
