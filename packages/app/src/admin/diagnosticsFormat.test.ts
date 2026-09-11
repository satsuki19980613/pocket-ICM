import { describe, expect, it } from 'vitest';
import {
  clientErrorKindLabelJa,
  describeCorrections,
  deviceSummary,
  fmtDateTime,
  formatSolveMs,
  hasCorrections,
  runSpotLine,
  runState,
  runStateLabelJa,
  stringList,
  STUCK_AFTER_MS,
} from './diagnosticsFormat';

const NOW = Date.parse('2026-09-11T10:00:00Z');
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

describe('runState', () => {
  it('完了・失敗・中断はそのまま', () => {
    expect(runState('done', iso(0), NOW)).toBe('done');
    expect(runState('failed', iso(0), NOW)).toBe('failed');
    expect(runState('aborted', iso(0), NOW)).toBe('aborted');
  });

  it('計算中は10分経つまで計算中、経ったら止まったまま（SQL と同じ境界）', () => {
    expect(runState('solving', iso(STUCK_AFTER_MS - 1), NOW)).toBe('solving');
    expect(runState('solving', iso(STUCK_AFTER_MS), NOW)).toBe('stuck');
  });

  it('日時が読めない計算中は止まったことにしない・知らない状態は失敗として目立たせる', () => {
    expect(runState('solving', 'not-a-date', NOW)).toBe('solving');
    expect(runState('weird', iso(0), NOW)).toBe('failed');
  });

  it('ラベル', () => {
    expect(runStateLabelJa('stuck')).toBe('止まったまま');
    expect(runStateLabelJa('done')).toBe('完了');
  });
});

describe('hasCorrections', () => {
  it('無い・形が違うものは直していない', () => {
    expect(hasCorrections(null)).toBe(false);
    expect(hasCorrections([])).toBe(false);
    expect(hasCorrections('x')).toBe(false);
    expect(hasCorrections({ seats: [] })).toBe(false);
  });

  it('席を1つでも直した・席以外を直した', () => {
    expect(hasCorrections({ seats: [{ pos: 'BTN', field: 'stack', from: 10, to: 12 }] })).toBe(true);
    expect(hasCorrections({ seats: [], heroHand: { from: 'AKs', to: 'AQs' } })).toBe(true);
  });
});

describe('describeCorrections', () => {
  it('直した箇所を1行ずつ読み下す', () => {
    expect(
      describeCorrections({
        playersLeft: { from: 5, to: 4 },
        heroHand: { from: 'AKs', to: 'AQs' },
        blinds: { bb: { from: 200, to: 400 } },
        ante: { amount: { from: 25, to: 50 } },
        seats: [
          { pos: 'BTN', field: 'stack', from: 12.5, to: 15 },
          { pos: 'SB', field: 'state', from: 'folded', to: 'active' },
        ],
      }),
    ).toEqual([
      '人数: 5 → 4',
      'ハンド: AKs → AQs',
      'BB: 200 → 400',
      'アンティ: 25 → 50',
      'BTN スタック: 12.5 → 15',
      'SB 状態: folded → active',
    ]);
  });

  it('壊れた要素は飛ばす', () => {
    expect(describeCorrections({ seats: [null, 3, { pos: 'CO', field: 'bet' }] })).toEqual([]);
    expect(describeCorrections(null)).toEqual([]);
  });
});

describe('stringList', () => {
  it('文字列だけ拾う', () => {
    expect(stringList(['a', 1, '', null, 'b'])).toEqual(['a', 'b']);
    expect(stringList('a')).toEqual([]);
  });
});

describe('clientErrorKindLabelJa', () => {
  it('種類のラベル・知らない種類はそのまま', () => {
    expect(clientErrorKindLabelJa('render')).toBe('画面の表示失敗');
    expect(clientErrorKindLabelJa('sync')).toBe('サーバへの保存失敗');
    expect(clientErrorKindLabelJa('new_kind')).toBe('new_kind');
  });
});

describe('fmtDateTime', () => {
  it('端末の時刻で M/D HH:mm', () => {
    expect(fmtDateTime(new Date(2026, 8, 11, 9, 5).toISOString())).toBe('9/11 09:05');
  });

  it('読めない日時はそのまま返す', () => {
    expect(fmtDateTime('x')).toBe('x');
  });
});

describe('formatSolveMs', () => {
  it('1秒未満は ms・以上は秒', () => {
    expect(formatSolveMs(null)).toBe('—');
    expect(formatSolveMs(850)).toBe('850ms');
    expect(formatSolveMs(2345)).toBe('2.3秒');
  });
});

describe('deviceSummary', () => {
  it('iPhone は Mac より先に見分ける', () => {
    expect(
      deviceSummary({
        ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15',
        w: 1179,
        h: 2556,
      }),
    ).toBe('iOS 1179×2556');
  });

  it('Android・大きさ不明', () => {
    expect(deviceSummary({ ua: 'Mozilla/5.0 (Linux; Android 15; Pixel 9)' })).toBe('Android');
  });

  it('形が違えば —', () => {
    expect(deviceSummary(null)).toBe('—');
  });
});

describe('runSpotLine', () => {
  it('人数・ヒーロー・時間・公開', () => {
    expect(runSpotLine({ players_left: 5, hero_pos: 'BTN', hero_hand: 'AKo', solve_ms: 2345, is_public: false })).toBe(
      '5人 · BTN AKo · 2.3秒 · 非公開',
    );
  });

  it('分からない項目は省く', () => {
    expect(runSpotLine({ players_left: null, hero_pos: null, hero_hand: null, solve_ms: null, is_public: true })).toBe('公開');
  });
});
