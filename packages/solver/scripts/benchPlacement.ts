/**
 * マルチウェイ着順分布の生成コスト実測（IMPLEMENTATION_PLAN 1-4 / R-9 の前倒し検証）。
 *
 * 実行:
 *   node --import tsx packages/solver/scripts/benchPlacement.ts
 *
 * 計測項目:
 *   1. MC スループット（k=3..6, samples/sec）
 *   2. 3-way の MC 収束（サンプル数 → 厳密分布との TV / maxAbsDiff）
 *   3. フルキャッシュ規模の見積り（3/4/5-way）
 *   4. 求解時オンザフライ MC のコスト感
 *
 * 出力は stderr（人間可読）。数値は docs/MC_COST_FINDINGS.md に転記する。
 */

import { parseCard, eval7 } from '../src/evaluator.js';
import { handClassToCombos, HAND_CLASS_ORDER } from '../src/huEquity.js';
import {
  DeterministicRng,
  placementDistributionExact,
  placementDistributionMC,
  distTotalVariation,
  distMaxAbsDiff,
} from '../src/placement.js';

const log = (s: string): void => void process.stderr.write(s + '\n');
const now = (): number => Number(process.hrtime.bigint() / 1000000n);

const HANDS_6 = [
  ['Ah', 'As'],
  ['Kh', 'Ks'],
  ['Qh', 'Qs'],
  ['Jh', 'Js'],
  ['Th', 'Ts'],
  ['9h', '9s'],
].map(([a, b]) => [parseCard(a!), parseCard(b!)] as [number, number]);

function throughput(): void {
  log('## 1. MC スループット（固定タプル, N=100000）');
  const N = 100000;
  for (let k = 3; k <= 6; k++) {
    const hands = HANDS_6.slice(0, k);
    const rng = new DeterministicRng(1);
    const t0 = now();
    placementDistributionMC(hands, N, rng);
    const ms = now() - t0;
    const persec = Math.round((N / ms) * 1000);
    log(`  k=${k}: ${ms}ms  (${persec.toLocaleString()} showdowns/sec)`);
  }
}

function convergence3way(): void {
  log('\n## 2. 3-way MC 収束（厳密分布との距離）');
  const hands = HANDS_6.slice(0, 3);
  const t0 = now();
  const exact = placementDistributionExact(hands);
  log(`  厳密全列挙 C(46,5)=1,370,754: ${now() - t0}ms（キャッシュ生成の1タプル分コスト）`);
  for (const N of [1000, 5000, 20000, 100000, 300000]) {
    const mc = placementDistributionMC(hands, N, new DeterministicRng(999));
    log(
      `  N=${N.toLocaleString().padStart(9)}: TV=${distTotalVariation(exact, mc).toFixed(5)}  maxAbs=${distMaxAbsDiff(exact, mc).toFixed(5)}`,
    );
  }
}

function cacheEstimates(): void {
  log('\n## 3. フルキャッシュ規模の見積り');
  // 着順 signature 数の上限 = Fubini 数（順序付き集合分割）
  const fubini = [1, 1, 3, 13, 75, 541, 4683];
  // 未順序クラス多重集合数 = C(169+k-1, k)
  const comb = (n: number, k: number): number => {
    let r = 1;
    for (let i = 0; i < k; i++) r = (r * (n + i)) / (i + 1);
    return Math.round(r);
  };
  for (let k = 3; k <= 5; k++) {
    const tuples = comb(169, k);
    const sigs = fubini[k]!;
    const bytesPerEntry = sigs * 4 + 8; // float32×sig + key
    const gb = (tuples * bytesPerEntry) / 1024 ** 3;
    log(
      `  ${k}-way: 多重集合 ${tuples.toLocaleString()} × 最大 ${sigs} sig ≈ ${gb.toFixed(2)} GB（未圧縮, 厳密生成は1タプル≈全列挙）`,
    );
  }
}

function onTheFly(): void {
  log('\n## 4. 求解時オンザフライ MC のコスト感');
  // FP 1 反復で必要な showdown 数 ≈ 参加クラスタプル数。範囲サイズ R, k-way で R^k。
  const rng = new DeterministicRng(1);
  const hands = HANDS_6.slice(0, 3);
  const N = 4000; // タプルあたりサンプル
  const t0 = now();
  placementDistributionMC(hands, N, rng);
  const msPerTuple = (now() - t0) || 0.001;
  log(`  3-way, N=${N}/タプル: ${msPerTuple.toFixed(2)}ms/タプル`);
  for (const R of [30, 80, 160]) {
    const tuples3 = R ** 3;
    log(
      `  レンジ幅 R=${R}: 3-way タプル ${tuples3.toLocaleString()} → 1パス ${((tuples3 * msPerTuple) / 1000).toFixed(1)}s（N=${N}）`,
    );
  }
}

/**
 * 推奨アプローチ: ノードレベルのレンジ MC。
 * 各参加者のレンジからハンドを1つ引き（衝突は棄却）、ボードを引き、評価して着順を集計。
 * コストは O(S)（レンジ幅・k のタプル数 R^k に依存しない）。
 */
function nodeLevelRangeMC(): void {
  log('\n## 5. 推奨: ノードレベル レンジ MC（O(S), R^k 非依存）');
  // クラス代表として上位・任意のクラスから広めのレンジを作る（幅の影響が無いことの確認用）。
  const rng = new DeterministicRng(2024);
  const S = 100000;
  for (const [k, R] of [
    [3, 80],
    [5, 120],
    [6, 169],
  ] as [number, number][]) {
    // 各プレイヤーに R クラス（先頭 R 個）を割り当て、そのコンボ集合を用意。
    const rangeCombos: [number, number][][] = [];
    for (let p = 0; p < k; p++) {
      const combos: [number, number][] = [];
      for (let c = 0; c < R; c++) {
        for (const cc of handClassToCombos(HAND_CLASS_ORDER[c]!)) combos.push(cc);
      }
      rangeCombos.push(combos);
    }
    const bufs = Array.from({ length: k }, () => new Array<number>(7).fill(0));
    const scores = new Array<number>(k);
    const used = new Uint8Array(52);
    const board = new Array<number>(5);
    let done = 0;
    const t0 = now();
    for (let s = 0; s < S; s++) {
      used.fill(0);
      let ok = true;
      // 各プレイヤーのハンドを棄却サンプリング
      for (let p = 0; p < k && ok; p++) {
        let tries = 0;
        while (true) {
          const combo = rangeCombos[p]![rng.nextInt(rangeCombos[p]!.length)]!;
          if (!used[combo[0]] && !used[combo[1]]) {
            used[combo[0]] = 1;
            used[combo[1]] = 1;
            bufs[p]![0] = combo[0];
            bufs[p]![1] = combo[1];
            break;
          }
          if (++tries > 50) {
            ok = false;
            break;
          }
        }
      }
      if (!ok) continue;
      // ボード5枚
      for (let i = 0; i < 5; i++) {
        let card: number;
        do {
          card = rng.nextInt(52);
        } while (used[card]);
        used[card] = 1;
        board[i] = card;
      }
      for (let p = 0; p < k; p++) {
        for (let i = 0; i < 5; i++) bufs[p]![2 + i] = board[i]!;
        scores[p] = eval7(bufs[p]!);
      }
      done++;
    }
    const ms = now() - t0;
    log(
      `  k=${k}, レンジ幅 R=${R}: ${ms}ms / ${S.toLocaleString()} samples  (${Math.round((done / ms) * 1000).toLocaleString()} showdowns/sec) → 1ノード≈${ms}ms`,
    );
  }
}

function main(): void {
  log('# マルチウェイ着順分布 コスト実測');
  log(`node ${process.version}\n`);
  throughput();
  convergence3way();
  cacheEstimates();
  onTheFly();
  nodeLevelRangeMC();
}

main();
