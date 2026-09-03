/**
 * プロトタイプ（妥当性検証・dev専用）: 「多人数の all-in 勝率を、ペア(2人)勝率の
 * 事前計算表から独立近似で高速に出せるか」を、厳密な多人数勝率と照合する。
 *
 * これが成立すれば「解くたびに実行時MCで配る」代わりに「ペア表を引いて算数」で
 * 多人数エクイティを出せる＝HRC流の高速化が可能。ずれが大きければ諦め判断の材料。
 */
import { eval7 } from '../src/evaluator.js';
import { exactEquityVsHands, handClassToCombos } from '../src/huEquity.js';

type Card = number;
type Hand = readonly [Card, Card];

/** クラス表記の配列 → 衝突しない具体コンボ（各クラスの先頭側から総当たりで確保）。 */
function pickHands(labels: string[]): Hand[] {
  const used = new Set<Card>();
  const hands: Hand[] = [];
  for (const lab of labels) {
    let picked: Hand | null = null;
    for (const [a, b] of handClassToCombos(lab)) {
      if (!used.has(a) && !used.has(b)) { picked = [a, b]; break; }
    }
    if (!picked) throw new Error(`no non-colliding combo for ${lab}`);
    used.add(picked[0]); used.add(picked[1]);
    hands.push(picked);
  }
  return hands;
}

/** k 人の厳密 all-in equity（全ボード列挙, 単一ポット・分けは均等割）と、strict win 率。 */
function exactMultiway(hands: Hand[]): { equity: number[]; strictWin: number[] } {
  const k = hands.length;
  const used = new Set<Card>();
  for (const [a, b] of hands) { used.add(a); used.add(b); }
  const deck: Card[] = [];
  for (let c = 0; c < 52; c++) if (!used.has(c)) deck.push(c);
  const bufs = hands.map(([a, b]) => [a, b, 0, 0, 0, 0, 0]);
  const scores = new Array<number>(k);
  const equity = new Array<number>(k).fill(0);
  const strict = new Array<number>(k).fill(0);
  let total = 0;
  const n = deck.length;
  // C(n,5) 全列挙
  for (let a = 0; a < n - 4; a++)
    for (let b = a + 1; b < n - 3; b++)
      for (let c = b + 1; c < n - 2; c++)
        for (let d = c + 1; d < n - 1; d++)
          for (let e = d + 1; e < n; e++) {
            const b0 = deck[a]!, b1 = deck[b]!, b2 = deck[c]!, b3 = deck[d]!, b4 = deck[e]!;
            let best = -1, nBest = 0;
            for (let p = 0; p < k; p++) {
              const bf = bufs[p]!;
              bf[2] = b0; bf[3] = b1; bf[4] = b2; bf[5] = b3; bf[6] = b4;
              const s = eval7(bf); scores[p] = s;
              if (s > best) { best = s; nBest = 1; } else if (s === best) nBest++;
            }
            for (let p = 0; p < k; p++) {
              if (scores[p] === best) { equity[p]! += 1 / nBest; if (nBest === 1) strict[p]!++; }
            }
            total++;
          }
  for (let p = 0; p < k; p++) { equity[p]! /= total; strict[p]! /= total; }
  return { equity, strictWin: strict };
}

/** ペア勝率表（この手 vs この手の win/tie/lose）。今回は対象手だけ厳密計算。 */
function pairwise(hands: Hand[]): { win: number[][]; eq: number[][] } {
  const k = hands.length;
  const win = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const eq = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  for (let i = 0; i < k; i++)
    for (let j = 0; j < k; j++) {
      if (i === j) continue;
      const r = exactEquityVsHands(hands[i]!, hands[j]!);
      win[i]![j] = r.win / r.total;          // P(i strictly beats j)
      eq[i]![j] = (r.win + r.tie / 2) / r.total; // pairwise equity
    }
  return { win, eq };
}

/** 独立近似: P(i sole win)≈∏ P(i beats j)。equity 近似も ∏ eq で見る。 */
function approxFromPairwise(pw: { win: number[][]; eq: number[][] }): { strictWin: number[]; equity: number[] } {
  const k = pw.win.length;
  const strictWin = new Array<number>(k).fill(1);
  const equity = new Array<number>(k).fill(1);
  for (let i = 0; i < k; i++)
    for (let j = 0; j < k; j++) {
      if (i === j) continue;
      strictWin[i]! *= pw.win[i]![j]!;
      equity[i]! *= pw.eq[i]![j]!;
    }
  return { strictWin, equity };
}

function fmt(a: number[]): string { return a.map((x) => (x * 100).toFixed(1).padStart(5)).join(' '); }
function maxErr(a: number[], b: number[]): number { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i]! - b[i]!)); return m; }

const SETS: { name: string; labels: string[] }[] = [
  { name: '3way 高ペア(相関大)', labels: ['AA', 'KK', 'QQ'] },
  { name: '3way 混在', labels: ['AKs', 'QJo', '55'] },
  { name: '4way 混在', labels: ['AA', 'KQs', 'T9o', '22'] },
  { name: '6way 典型', labels: ['AA', 'KQo', 'JTs', '99', 'A5s', '76o'] },
];

for (const set of SETS) {
  const hands = pickHands(set.labels);
  const t0 = Date.now();
  const ex = exactMultiway(hands);
  const tEx = Date.now() - t0;
  const t1 = Date.now();
  const pw = pairwise(hands);
  const ap = approxFromPairwise(pw);
  const tAp = Date.now() - t1;
  console.log(`\n=== ${set.name}  (${set.labels.join(', ')}) ===`);
  console.log(`  厳密 equity   %: ${fmt(ex.equity)}   (全ボード列挙 ${tEx}ms)`);
  console.log(`  近似 ∏eq      %: ${fmt(ap.equity)}   (ペア表 ${tAp}ms)`);
  console.log(`  equity 最大誤差: ${(maxErr(ex.equity, ap.equity) * 100).toFixed(2)} pt`);
  console.log(`  厳密 strictWin%: ${fmt(ex.strictWin)}`);
  console.log(`  近似 ∏win     %: ${fmt(ap.strictWin)}`);
  console.log(`  strictWin誤差 : ${(maxErr(ex.strictWin, ap.strictWin) * 100).toFixed(2)} pt`);
}
