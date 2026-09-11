import { describe, expect, it } from 'vitest';

import { planEviction, type EvictionCandidate } from './purgePlan';

const MB = 1024 * 1024;

function files(owner: string, n: number, sizeMb: number, opts: { protected?: boolean; startDay?: number } = {}): EvictionCandidate[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${owner}-${i}`,
    owner,
    size: sizeMb * MB,
    createdAt: new Date(Date.UTC(2026, 0, (opts.startDay ?? 1) + i)).toISOString(),
    protected: opts.protected ?? false,
  }));
}

describe('planEviction（総量上限を超えたときに消すスクショ）', () => {
  it('上限以内なら何も消さない', () => {
    expect(planEviction([...files('a', 3, 1), ...files('b', 3, 1)], 10 * MB)).toEqual([]);
  });

  it('1人が大量に上げて保護にしても、取り分以内の他の人のスクショは消さない', () => {
    // 攻撃者: 保護ファイル 9MB。被害者候補: 非保護 1MB × 2（取り分 5MB 以内）。上限 10MB。
    const plan = planEviction([...files('attacker', 9, 1, { protected: true }), ...files('victim', 2, 1)], 10 * MB);
    expect(plan).toEqual([]);
  });

  it('保護ファイルだけで上限以上なら何も消さない（警告だけ）', () => {
    expect(planEviction([...files('a', 12, 1, { protected: true }), ...files('b', 1, 1)], 10 * MB)).toEqual([]);
  });

  it('取り分を超えている人の古い非保護ファイルから、上限に収まるまで消す', () => {
    // heavy: 非保護 10MB、light: 非保護 2MB。上限 10MB・取り分 5MB → heavy の古い順に 2 個消せば 10MB に収まる。
    const plan = planEviction([...files('heavy', 10, 1), ...files('light', 2, 1)], 10 * MB);
    expect(plan).toEqual(['heavy-0', 'heavy-1']);
  });

  it('いちばん使っている人から順に消し、取り分以内になった人は対象から外す', () => {
    // a: 8MB, b: 6MB, c: 1MB（すべて非保護）。上限 9MB・取り分 3MB。
    const plan = planEviction([...files('a', 8, 1), ...files('b', 6, 1), ...files('c', 1, 1)], 9 * MB);
    expect(plan.filter((id) => id.startsWith('c'))).toEqual([]);
    // 15MB → 9MB に 6 個消す。a が多い間は a、並んだら交互。
    expect(plan.length).toBe(6);
    expect(plan[0]).toBe('a-0');
  });

  it('取り分以内になった人・非保護が尽きた人は対象外で、上限を超えたままでも止まる', () => {
    // 上限 5MB・取り分 2.5MB。a: 保護 4MB ＋ 非保護 2MB、b: 非保護 3MB。合計 9MB。
    const aProtected = files('a', 4, 1, { protected: true }).map((f) => ({ ...f, id: `ap-${f.id}` }));
    const plan = planEviction([...aProtected, ...files('a', 2, 1, { startDay: 20 }), ...files('b', 3, 1)], 5 * MB);
    // a の非保護 2 個 → b が取り分を超えている分の 1 個 → b が 2MB（取り分以内）になったら止まる
    // （合計 6MB で上限は超えたまま＝ warn_over_limit で知らせる）。a の保護ファイルは消さない。
    expect(plan).toEqual(['a-0', 'a-1', 'b-0']);
  });
});
