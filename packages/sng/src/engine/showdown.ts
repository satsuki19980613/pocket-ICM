/**
 * ショーダウン評価とサイドポット分配（整数チップへの丸め込み）。
 *
 * `distributePots`（@oshihiki/solver/sidepot）は実数で返す（同着の割り勘は端数が出ることがある）。
 * 端数チップは「ボタンの次の席から時計回りで優先」（docs/SNG_DESIGN.md §1）で 1 枚ずつ配る。
 * 端数を持つ（＝同着の分け前を受け取った）席だけが候補になる。
 */

import { eval7, parseCard } from '@oshihiki/solver/evaluator';
import { distributePots } from '@oshihiki/solver/sidepot';

/**
 * @param btn ボタン席（端数の優先順の基準。btn+1 から時計回り）。
 * @param folded 席ごとの「このハンドで降りたか」（降りていれば eligible=false）。
 * @param seated 席ごとの「このハンドに参加していたか」（そもそも配られていない席は除外）。
 * @param hole 席ごとの手札（folded/未参加はいなくてよい）。
 */
export function settleShowdown(
  commits: readonly number[],
  folded: readonly boolean[],
  seated: readonly boolean[],
  hole: Readonly<Record<number, readonly [string, string]>>,
  board: readonly string[],
  btn: number,
): number[] {
  const n = commits.length;
  const eligible = new Array<boolean>(n).fill(false);
  const score = new Array<number>(n).fill(-1);
  for (let s = 0; s < n; s++) {
    if (!seated[s] || folded[s]) continue;
    const h = hole[s];
    if (!h) continue;
    eligible[s] = true;
    const cards = [...h, ...board].map(parseCard);
    score[s] = eval7(cards);
  }
  const strongerCount = new Array<number>(n).fill(0);
  for (let s = 0; s < n; s++) {
    if (!eligible[s]) continue;
    let cnt = 0;
    for (let o = 0; o < n; o++) {
      if (o === s || !eligible[o]) continue;
      if (score[o]! > score[s]!) cnt++;
    }
    strongerCount[s] = cnt;
  }

  const raw = distributePots(commits, eligible, strongerCount);
  return roundOddChips(raw, btn);
}

/**
 * 降ろして終わったハンド（1 人だけ残った）の分配。ショーダウンなしで全額を勝者へ。
 */
export function settleUncontested(commits: readonly number[], winner: number): number[] {
  const n = commits.length;
  const won = new Array<number>(n).fill(0);
  let total = 0;
  for (const c of commits) total += c;
  won[winner] = total;
  return won;
}

/**
 * 実数の分配を整数チップへ。全席 floor した後、余りをボタンの次の席から時計回りで
 * 「端数を持つ席（floor で切り捨てられた席）」に 1 枚ずつ配る。Σ が保存されるよう常に
 * 総額ぶんだけ配り切る。
 */
function roundOddChips(raw: readonly number[], btn: number): number[] {
  const n = raw.length;
  const floors = raw.map((v) => Math.floor(v + 1e-9));
  let totalRaw = 0;
  let totalFloor = 0;
  for (let i = 0; i < n; i++) {
    totalRaw += raw[i]!;
    totalFloor += floors[i]!;
  }
  let leftover = Math.round(totalRaw - totalFloor);
  if (leftover <= 0) return floors;

  // 端数を持つ（= raw が floor と一致しない）席を、btn+1 から時計回りで並べる。
  const fractional: number[] = [];
  for (let i = 1; i <= n; i++) {
    const seat = (btn + i) % n;
    if (raw[seat]! - floors[seat]! > 1e-9) fractional.push(seat);
  }
  const out = floors.slice();
  let i = 0;
  while (leftover > 0 && fractional.length > 0) {
    const seat = fractional[i % fractional.length]!;
    out[seat] = out[seat]! + 1;
    leftover--;
    i++;
  }
  return out;
}
