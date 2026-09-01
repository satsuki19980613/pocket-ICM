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

---

# 5. M5 実験 — hero カードリムーバル補正（アクション確率）: 負の結果

版: 2026-09-01 / 対象: `packages/solver/src/cardRemoval.ts`, `nwaySolver.ts`（`cardRemoval` opt-in）

§3.4 の精度改善候補 **#1「アクション確率への hero カードリムーバル反映」** を実装・評価した。
結論から言うと **HRC 5-way 照合はむしろ悪化**し、**既定は card-blind のまま**とした。

## 5.1 仮説と実装

card-blind の `rangeFraction`（コンボ加重レンジ比）では、後方プレイヤーがアグレッシブに出る
確率が hero の持ち札に依存しない。だが hero が特定 2 枚 {x,y} を持てば、その 2 枚は後方レンジから
物理的に除かれる。押し引きレンジは高カードに偏るため、この効果が **早い位置・多人数の
fold-through 見積り** に効き、先手 push レンジが狭く出る主因ではないか、という仮説（§3.4-1）。

実装は hero **クラス条件つき**の一次補正（`cardRemoval.ts`）。後方プレイヤー j のアグレッシブ確率を

```
p_j(c) = ( W_j − avgU_j(c) + freq_j[c] ) / C(50,2)
```

とし（W_j=加重コンボ数, U_j[k]=カード k を含むコンボの freq 総和, avgU=hero クラス c の使用札平均）、
hero のアグレッシブ EV を後方ツリーの DFS でクラス別に評価する。**この解析式は全 1326 コンボの
ブルートフォース平均と 12 桁一致**（`test/cardRemoval.test.ts`）— 式そのものは厳密。

## 5.2 測定（`OSHIHIKI_CARD_REMOVAL=1 node --import tsx scripts/validateHrc5way.ts`）

実 HRC 5-way（10/20/30/23/12bb, ante all 0.25）, maxIters 800, samples 80k, workers=16。

| ノード | card-blind（既定） | cardRemoval:true | HRC |
|---|---|---|---|
| UTG PU | 14.8 | 15.0 | 19.8 |
| CO PU | 15.1 | 15.0 | 24.0 |
| BU PU | 82.0 | 77.1 | 87.3 |
| 平均 \|freq% 差\| | **1.68** | **1.98（悪化）** | — |
| exploitability | 0.0170（`converged=false`） | 0.0157（`converged=true`） | — |
| EQPre/EQPost 一致 | ◎ | ◎（不変） | — |

- 狙った **UTG/CO の先手 push はほぼ動かず**（±0.2pt）、**BU push は 82→77 と HRC から離れた**。
- `converged=true` は **見かけ倒し**: 自作の exploitability 指標（MC pcEq のバイアス床を含む）で
  「より小さい」点に収束しただけで、**参照解（HRC）からは遠のいた**。R-1 が警告する
  「動いている風に見えるが微妙にズレている」状態そのもの。EQ は純 ICM 支配なので不変。

## 5.3 なぜ悪化したか

本補正は **「hero のみ除去」の一次近似**で、**既にオールインしているプレイヤー（集合 S）の札を
除去しない**。HRC は完全なレンジ vs レンジのカードリムーバル。**片側だけの部分補正**は、
card-blind の「平均場」よりかえって真の解から離れることがある（部分補正のオーバーシュート）。
実際、hero がゴミ札（例 32o）を持つと残デッキが相手の高カードレンジに偏り、相手のコール確率が
**上がる**方向に正しく効くため BU の限界 push 札が落ち、BU push は 82→77 と狭くなった。これは
物理的には正しいが、HRC の 87.3（完全カードリムーバル下の均衡）とは逆方向であり、一次近似の
不完全性を示す。

## 5.4 判断と申し送り

- **既定は card-blind（M4 検証済みベースライン, 1.68pt）を維持。** `cardRemoval` は opt-in
  （`solveMultiway({cardRemoval:true})` / `OSHIHIKI_CARD_REMOVAL=1`）として実装・テストを残す。
  再現とその上に積む足場のため。
- 先手 push レンジの狭さ（HRC 比 −5〜9pt, 位置スプレッドの圧縮 UTG≈CO）は **一次カードリムーバルでは
  閉じない**ことが判明した。次に試すべきは:
  1. **完全なレンジ vs レンジのカードリムーバル**（committed プレイヤーの札も除去）。本 §5 の
     `cardRemoval.ts` は hero 側の除去プリミティブとして再利用できる。
  2. **FP → CFR 系**（多人数の均衡選択がHRCと割れている可能性の切り分け）。
  3. exploitability 床自体の低減（pcEq の層化・コントロールバリエイト, §3.4-2）。
- EQ（EQPre/EQPost）は実データで一致し続けており、**アプリの EV/EQ 表示は既定 card-blind で妥当**。
  先手 push の端 1〜数ハンドの差は §4.3 の境界許容と `converged` 通知で正直に扱う。
