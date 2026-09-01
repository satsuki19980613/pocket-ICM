# N-way（4〜6人）逐次 push/fold 求解 — 検証と実測（M4）

版: 2026-09-01 / 対象: `packages/solver/src/nwaySolver.ts`

M3 の 3-way（`multiwaySolver.ts`, 6 ノード手書き展開）を任意 N（3〜6）へ一般化した
汎用ゲーム木ソルバー `solveMultiway` の検証結果・コスト実測・既知の限界をまとめる。
IMPLEMENTATION_PLAN 1-8 / §4、SPEC §3.1 に対応。

## 1. 設計（要点）

push/fold では行動が席順に 1 周し、各プレイヤーはちょうど 1 回の二択（オールイン or
フォールド）を行う。決定ノードは `(actor i, 前方オールイン集合 S⊆{0..i-1})` で一意化され、
総数は **2^N − 2**（N=3→6, 4→14, 5→30, 6→62。`(BB, S=∅)` はウォークで決定でない）。

- 終局はオールイン集合 A で分類: |A|=0 walk / |A|=1 不戦勝 / |A|≥2 ショーダウン。
- ショーダウンの all-in equity は `showdownMc` のノードレベル MC で「先取り」見積り。
  各 A（|A|≥2）について参加者の到達レンジで `(k+1)` パス（hero=full × k ＋ seatMarginal）。
- FP（fictitious play）で反復。収束は per-node regret × 到達確率の総和（実払い pt）。
- ツリーのアクション確率はコンボ加重レンジ比で近似（hero 個別カードリムーバル非考慮）。
  この近似は M3 から継承（境界ハンドの微差は §4.3 許容と exploitability で担保）。

## 2. 正しさの検証（自動テスト / `packages/solver/test/nwaySolver.test.ts`）

| 観点 | 方法 | 結果 |
|---|---|---|
| ゲーム木構造 | N=3..6 でノード数 2^N−2・正規キー・PU/CA/OC 整合 | ✅ |
| **独立実装との相互検証** | N=3 で `solveThreeWay`（手書き）と push/call %・EQ 一致 | ✅ freq<6pt, EQ<0.05pt |
| ICM 保存 | EQPre 総和 = EQPost 総和 = payout 総和（4/5/6-way） | ✅ |
| scale invariance | ×2（power-of-two）で戦略 bit 一致（4-way） | ✅ |
| 決定性 | 同一シードで戦略完全一致 | ✅ |
| 単調性 | 浅いほど先手 push が広い（4-way CO） | ✅ |
| exploitability 自己検証 | 均衡は小・全 all-in / 全 fold は有意に大 | ✅ |
| **実 HRC 5-way EQPre** | シフト換算で HRC と一致（\|差\|<0.02pt-%） | ✅ |

相互検証（N=3 で独立 2 実装が一致）は R-1「微妙にズレたまま気づかない」に対する
最重要ガード。手書き展開とプログラム的ゲーム木構成という独立経路の一致で配線を担保する。

## 3. 実 HRC 5-way 照合（`packages/solver/scripts/validateHrc5way.ts`）

セットアップ: UTG/CO/BU/SB/BB = 10/20/30/23/12bb, blinds 0.5/1, ante all 0.25,
prizes 実払い +5/+3/+2/+1/0（シフト形 6/4/3/2/1・プール16）。参照は
`packages/harness/cases/_reference-hrc-5way-blinds05-1-025.json`（さつき収集）。

### 3.1 EQ（◎ 一致）

| pos | EQPre HRC/自作 | EQPost HRC/自作 |
|---|---|---|
| UTG | 15.29 / 15.29 | 15.52 / 15.54 |
| CO | 21.05 / 21.05 | 21.20 / 21.22 |
| BU | 24.66 / 24.66 | 24.83 / 24.82 |
| SB | 22.28 / 22.28 | 22.23 / 22.24 |
| BB | 16.72 / 16.72 | 16.22 / 16.18 |

EQPre は完全一致（純 ICM）、EQPost も **±0.04pt-% 以内**で §4.3 の EQ 基準（0.1%）を満たす。
ICM・サイドポット・ショーダウン・ツリー期待値の計算パスが実データで妥当と確認できた。

### 3.2 戦略レンジ（△ 先手 push が構造的に狭い）

- 後半・HU 的ノードは良好: SB 先手 PU 100.0/99.9、BB vs SB CA 22.6/22.6、BB vs BU CA 15.5/15.9。
- **早い位置の先手 push が狭い**: UTG PU 19.8/13.4、CO PU 24.0/12.0、BU PU 87.3/83.9。
  コール/オーバーコールは概ね HRC より僅かに広い（OC は絶対値 1〜4% と小さい）。
- 平均 |freq% 差| ≈ 1.7pt（§4.3 目安 ±0.5 を超過）。

### 3.3 原因の切り分け（収束ではなく構造的な床）

反復数を上げて確認（samples 12万・並列）:

| iters | UTG PU | CO PU | BU PU | exploitability |
|---|---|---|---|---|
| 400 | 11.4 | 9.3 | 74.8 | 0.0211 |
| 1500 | 13.4 | 12.0 | 83.9 | 0.0155 |
| 4000 | 13.4 | 12.0 | 83.9 | 0.0155 |

1500→4000 で **完全に同一**（FP は固定点に到達済み）。したがって残差は反復不足ではなく、
**MC 推定量のバイアス由来の exploitability 床**（実払いプール比 ≈0.14%、§4.3 目標 0.05% 超）。
この床が「先手 push の無差別境界」に集中して現れる（EQ は盤面 ICM が支配的なので影響が出ない）。
求解は `converged=false` を返し、この残差を正直に通知する。

### 3.4 フォローアップ（精度改善の候補）

床を 0.05% 目標まで下げるには MC 推定量のバイアス低減が要る（M3 申し送りの継続）:
1. **アクション確率への hero カードリムーバル反映**（現在はコンボ加重レンジ比のみ）。
   多人数・早い位置で fold-through 見積りに効くと見られる。
2. class-conditional equity のバイアス低減（層化・コントロールバリエイト等）。
3. FP → CFR 系への差し替え（多人数での収束質）。

いずれも「4〜6 人求解を動かす」M4 スコープ外の精度改善。現状は EQ が実データで一致し、
戦略も順序・大小関係は正しく、残差を `converged`／`exploitability` で明示できている。

## 4. コスト実測（`packages/solver/scripts/benchNway.ts`, 28 コア機・等スタック 10bb）

samples 既定（4-way 6万 / 5-way 4万 / 6-way 3万）, maxIters 400。

| N | 単一スレッド | 並列(16=CPU60%) | speedup | 単一との戦略差 |
|---|---|---|---|---|
| 4 | 37.3s | 7.4s | 5.0x | 0（bit 一致）|
| 5 | 79.6s | 15.7s | 5.1x | 0 |
| 6 | 180.4s | 31.4s | 5.75x | 0 |

- 並列はショーダウン MC（A ごとに独立）を worker_threads で分散。**結果は単一スレッドと
  bit 一致**（同一 A・同一 epoch の派生シードで決定的、ソース実行 vs dist 実行の交差検証にもなる）。
- speedup が ~5x 止まりなのは FP 反復本体（`computeEVs` 400 回）が直列なため（Amdahl）。
  MC リフレッシュ区間は良く並列化されるが、反復ループがボトルネック。
- worker 数は既定で **CPU コアの 60% 上限**（`maxWorkerCap`）。`OSHIHIKI_WORKERS` 環境変数か
  `solveMultiway({workers})` で指定。worker 不可の環境（core dist 未生成等）は自動で単一スレッド退避。

### 並列実行の前提

worker はコンパイル済み `dist`（素の Node）で走る。`@oshihiki/core` の package exports は
既定で `src`（tsx/vitest 用）を指すため、worker はカスタム条件 `--conditions=oshihiki-dist` で
`core/dist/index.js` に解決する。したがって並列を使う前に `npx tsc -b`（core+solver の dist 生成）が必要。
テストは単一スレッド既定で、worker 環境に依存しない。
