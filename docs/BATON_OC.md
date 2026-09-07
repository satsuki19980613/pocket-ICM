# バトン: OC（オーバーコール）以降の枝に、本当にシンプルな解決策は無いのか

**作成 2026-09-07 / 前セッション（Opus 5）から次セッション（Fable）への引き継ぎ**
**発注者: さつき（非エンジニアのプロジェクトディレクター, 日本語で対応）**

---

## 0. 結論から言うと、あなたに突き止めてほしいこと

> **3人以上の同時オールイン（＝OC が発生した枝）を、実質的に「解かずに済ませる」構造的な方法は
> 本当に存在しないのか。存在するなら実装し、存在しないならそれを証明して終わらせてほしい。**

さつきの主張（ポーカー歴の長い実戦家としての直感）:

> OC のレンジはほぼ AA しかない。ならば **OC が発生した時点で、その先はほとんど計算する
> 必要が無いはずだ。条件のパターンだけで構成できるのではないか。OC 以降の枝に時間を
> かけて計算する意味が分からない。**

前セッションで**この直感が実測で正しいこと**は確認済み（§2）。しかし
「だから計算不要」までは詰め切れていない（§4 に理由）。**そこが本件の争点。**

---

## 1. 前提（このプロジェクトの土台。読み飛ばさないこと）

- アプリ: **Black Ops ICM / Pocket ICM**（押し引きノート）。ポーカーチェイス クラブマッチ
  （6-max SNG）用の **push/fold（AOF: all-in or fold）ICM 復習ツール**。
  本番 https://pocket-icm.wsk641.workers.dev （Cloudflare Workers）
- **ゲーム木はこれだけ**: 各プレイヤーは席順に**ちょうど1回**行動し、二択のみ。
  - 前方に誰もオールインしていない → **PU**（push） / fold
  - 前方に1人オールイン → **CA**（call） / fold
  - 前方に2人以上オールイン → **OC**（overcall） / fold
  - **CA も OC もオールイン。レイズもコールも存在しない。**
  - 決定ノード数 = 2^N − 2（N=4→14, N=6→62）
- 条件は全固定: 賞金 [+5..−1] 相当、ante **all 0.25bb**、blinds sb0.5/bb1、初期75bb。
- 2人 / 3人 / 4人は**事前計算テーブル**で瞬時（実効≤25bb かつ条件一致のとき）。
  **5-6人と、相手が25bb超の局面は実時間 MC 求解**＝ここが遅い。
- 用語規定（厳守）: 「押し引き」は**使わない**。**push or fold / AOF** と書く。

### 関連コード
| ファイル | 役割 |
|---|---|
| `packages/solver/src/nwaySolver.ts` | N-way(3〜6) FP ソルバー本体。`refresh()` がショーダウン集合ごとの equity を更新 |
| `packages/solver/src/showdownJob.ts` | `computeShowdownMc()`: 1 ショーダウン集合の MC。**k+1 パス**（各参加者を hero=全169クラスにした k パス + marginal 1 パス） |
| `packages/solver/src/showdownMc.ts` | `estimateNodeEquities()`: 実際のサンプリング。**hero クラスをコンボ数比例で抽選（←ここが争点の核心, :199 付近）** |
| `packages/solver/src/showdownExact.ts` | **2人ショーダウンの厳密解**（前セッションで新設・検証済）。3人以上の手本になる |
| `packages/solver/src/huWinTieLoader.ts` | `loadHuWinTieTable()`。169×169 の厳密 win/tie 表（`artifacts/hu-wintie-169.f32.bin`, 228KB） |
| `packages/solver/src/sidepot.ts` | `finalStacksFromShowdown()`: サイドポット分配 |
| `packages/solver/src/monotonize.ts` | ハンドの**支配半順序**を既に実装済（OC の閾値構造を使うなら再利用できる） |

---

## 2. 実測で**確定済み**の事実（再検証不要。ここからスタートしてよい）

### (a) 3人以上のショーダウンは OC が起きたときにしか発生しない
2人オールイン＝ push + call。3人以上には必ず overcall が要る。**自明だが本件の起点。**

### (b) OC レンジは構造的に極端に狭い（全ノードダンプ実測, 8000反復）
| スポット | OCノード数 | OC幅 | 中身 |
|---|---|---|---|
| 4人 CO14/BU34/SB33/BB22 | 5 | 0.5〜1.4% | AA / AA KK QQ |
| 4人 全員10bb | 5 | 0.5〜1.4% | AA / AA KK / AA KK QQ |
| 6人 全員6bb | 42 | 0〜1.4% | AA / AA KK / AA KK QQ |
| 6人 全員10bb | 42 | 0〜0.9% | AA / AA KK / 無し |
| 6人 全員20bb | 42 | 0〜0.9% | AA / AA KK / 無し |

**例外なく {AA} ⊆ OCレンジ ⊆ {AA, KK, QQ}（または空）。人数にもスタック深さにも依存しない。**
対照: PU 中央値 38〜71% / CA 中央値 2.6〜8.4%。

### (c) 到達確率（参加者の到達レンジ幅の積＝上界）
- 3人集合: **0.005〜0.05%**
- 4人集合: **0.0003%（33万回に1回）**

### (d) それでも計算時間の **99%** が 3人以上の MC に費やされていた
2人は `showdownExact.ts` で厳密・ゼロコストになったため。

### (e) サンプルを削ると **OC レンジが先に壊れ、それが上流の PU レンジを崩す**
4人 HRC スポット, 8000反復, 3人以上に配るサンプル数別:

| サンプル | OCレンジ | 上流 PU |
|---|---|---|
| 24000 | AA KK QQ | CO 18.3% / BU 37.9% |
| 3000 | AA KK QQ | CO 18.6% / BU 37.9%（24000と同一） |
| 1500 | AA **AKs** KK QQ | CO 17.6% |
| **750** | AA KK QQ **JJ TT 99** | **CO 12.8% / BU 28.5%（崩壊）** |
| 375 | AA **AKs AKo AQs AQo** KK | CO 11.5% / BU 27.9% |

### (f) 真因: AA には全サンプルの **0.45%** しか当たっていない
`estimateNodeEquities` は hero クラスを**コンボ数比例**で抽選する。
AA は 6コンボ/1326 = **0.45%**。3000サンプルなら AA は約13回だけ。
一方、絶対に OC しない 72o（12コンボ）には 0.9% ＝**倍**が注がれている。
**＝ 労力の 99.55% が「必ず降りる166クラス」に費やされている。**

### (g) 到達確率比例のサンプル配分は**実装済み・検証済み**（`mcSamplesFor`）
`max(base/16, base/8^(k-2))`。本番経路（winTie＋worker8）実測:
- 4人 HRC スポット 8000反復: **41.9s → 4.5s（9.3倍）**、解は同一
- 6人卓10bb 8000反復: **493.2s → 40.1s（12.3倍）**、5席中4席が小数まで一致
  （残る CO 差 65.6↔71.0 は**バイアスではなく収束不足**と2通りで確定済み）
- 6人卓 OC 42ノード中、異常 **0件**
- 全448テスト green / tsc clean

---

## 3. ネットリサーチで判明した業界の実態（再調査不要）

- **HRC 標準の「Math」エンジンは最大3人まで。4人以上は Monte Carlo モード**（＝我々と同じ）。
  HRC 公式も「稀にしか通らないラインの EV は収束が非常に遅い」と明記。CI（Convergence
  Indicator）で管理し「squeeze や multiway など深いラインは CI<10 では収束しない」と注記。
  **＝ HRC も10人を厳密に解いてはいない。**
- **ICMIZER も用語が完全一致**（P / C / **O**＝overcall）。純戦略（100% or 0%）で解く点も同じ。
- **ICMIZER 開発者の 2+2 コメント（決定的）**:
  > 3-way の無制限レンジ vs レンジ vs レンジ計算は非常に厄介で、ICMIZER のコードベース全体で
  > **最も難しい部分の一つ**。現在の速度に到達するまで**何ヶ月もの作業**と各種最適化を要した。
- ICMIZER 公式ヘルプ:「オーバーコールレンジはスタック・チップ・相手レンジに応じて動的に決まり、
  **あらかじめ決まっていたり単純化されていたりはしない**」。
- **固定パターンではない証拠**: ICMIZER 公式例の BTN オーバーコールは **4.2%（99+, AQs+, AKo）**。
  さらに「押す側が40%まで広がると OC は **JJ+ に締まる**」＝相手レンジ依存で動く。
- 3人以上の preflop クラス3つ組は **818,805通り**（厳密表を作るなら、この規模）。

出典: holdemresources.net/blog/2020-02-hrc-update, /docs/monte-carlo-sampling,
support.icmpoker.com/en/articles/3925369-overcall-ranges,
forumserver.twoplustwo.com（ICMIZER スレ）, github.com/zekyll/OMPEval

---

## 4. なぜ前セッションで決着しなかったのか（争点の正確な形）

さつきの「OC 以降は計算不要」は、**2つの主張に分解**できる。前者は真、後者が未決着:

1. **真**: OC レンジは常に「レンジ上端の閾値」である（§2b で実測確認）。
2. **未決着**: だから OC 以降の枝は**解かずに済ませられる**。

未決着な理由は §2e。**OC レンジが少しでも壊れると、それが PU まで波及して結果が崩れる。**
到達確率が 0.05% しかないのに影響が大きいのは、OC が「上流の PU/CA がどれだけ押せるか」を
決めるフィードバック経路だから。つまり **OC は頻度は無視できるが、影響は無視できない。**

一方 §2f が示すのは、**現在の解き方が構造を全く使っていない**ということ。
閾値が上端にあると分かっているのに、労力の 99.55% を必ず降りる手に使っている。

**→ 争点は「計算するかしないか」ではなく「構造をどう使って計算量を落とすか」。**

---

## 5. あなた（Fable）への調査指示

### 5-1. 必ず最初にやること
1. この文書と `~/.claude/projects/.../memory/solve-speed-findings.md` を読む（詳細な数値履歴）。
2. §2 の事実は**再検証しなくてよい**。ゼロから測り直すのは時間の無駄。
3. **さつきに計画を提示して承認を得てから実装する**（このプロジェクトの進め方）。

### 5-2. 検証してほしい候補（前セッションの推奨順。順番は変えてよいが理由を述べること）

**候補A: 層化抽選（前セッションの第一推奨・未実装）**
hero のクラス抽選をコンボ数比例から**強さ階層で層化**する。上位30クラスに7割配分すれば
AA へのサンプルは 0.45% → 約2.3%（**5倍**）。OC は支配順序の閾値判定なので上位だけ高精度で足りる。
- 期待: 総サンプルをさらに 3〜5倍削減 → 6人卓 40秒 → **10秒前後**。しかも OC の精度は**向上**。
- 注意: `eq[c]` はクラス条件付き平均なので、抽選分布を変えても**不偏**（バイアスは入らない）。
  ただし `seatMarginal` パスは実レンジで引くので触らないこと。
- 検証: OC 42ノードの異常0件を維持しつつ、均等配分と同一解になるか。

**候補B: OC パスだけ厳密化 / Rao-Blackwell 化**
3人以上の集合では、参加者の1人（overcaller）のレンジが **1〜3クラス**しかない。
その参加者のハンドを**サンプリングせず全列挙**して期待値を取る（分散低減）。
- `showdownExact.ts` の2人厳密化と同じ発想。3人版の win/tie 分布が要るかを見極めること。
- サイドポットがあるので「勝者」だけでなく**順位（同着含む）の分布**が要る点に注意
  （3人なら順序付き分割 13通り）。

**候補C: パスごとにサンプルを配分し直す**
`computeShowdownMc` は k+1 パス。hero=pusher / caller のパスは、その集合の重みが 0.5% 程度に
減衰するので低精度で足りる。**hero=overcaller のパスだけ高精度**にする。
- 現状は全パス同数。`computeShowdownMc` のシグネチャ変更が要る。

**候補D: 3人厳密テーブル（重い。最後の手段）**
クラス3つ組 818,805通り。順序付き分割13通りの分布を f16 で持つと約20MB。
ただし**生成コストが未見積り**。`huTable.classWinTieCanonical` と
`scripts/genHuWinTieTable.ts`（24並列で約13分／2人）が出発点。
**OC が AA/KK/QQ に限られるなら「3人目が AA/KK/QQ のスライスだけ」で足りる可能性**があり、
その場合 169×169×3 に縮む。ここは検討価値あり。

**候補E: さつきの元の主張そのもの — OC ノードを解かずに閉じる**
OC が構造的に「上端の閾値」なら、**閾値の位置だけを二分探索で決める**（169クラス全部の EV を
求めない）。`monotonize.ts` の支配半順序が既にあるので、そこに乗せられるか検討する価値がある。
- **これがさつきの直感に一番近い案。真剣に検討してほしい。**

### 5-3. 明確に**却下済み**（蒸し返さないこと）
- ❌ 「無差別だから直せない/ノイズ床0.013pt」という説明 → **誤り**。真因は収束不足だった。
- ❌ 表示バンド（ev ≥ −BAND で押し寄せ）→ 検証で破綻・revert 済み。
- ❌ `cardRemoval: true`（カードバンチング）→ 収束後に再検証したが BU 37.9→32.4 と**悪化**。
- ❌ 深いスタックのクランプ（25bb に丸める）→ HRC と大きくズレて撤回済み。
- ❌ 「速いMC案（サンプル・反復を一律に下げる）」→ 単純形では精度が壊れる。

### 5-4. 再現手順
```bash
npm run typecheck          # tsc -b + scripts
npx vitest run             # 全448テスト
npx vitest run packages/solver
```
計測用の使い捨てスクリプトは `packages/solver/_*.ts` に置き、**終わったら削除**する
（`_bench6.ts` は既存なので残す）。`loadHuWinTieTable()` を渡さないと2人が厳密にならないので注意。

基準スポット（HRC 照合済み, 4人 CO14/BU34/SB33/BB22, ante all 0.25, sb0.5/bb1）:
**HRC: CO PU 17.6% / BU PU 44.5% / SB PU 100%**
現在の収束値: CO 18.6% / SB 100%（一致）/ **BU 37.9%（HRC 44.5 と −6.6pt の差が残る）**

### 5-5. さつきへの確認事項（未回答・引き継ぎ）
1. **【要確認】我々の OC レンジ（AA〜QQ）は狭すぎないか。**
   ICMIZER の公式例は BTN オーバーコール **4.2%（99+, AQs+, AKo）**。
   クラブマッチは最下位マイナスの急峻な賞金構造なのでリスクプレミアムが高く、狭くなるのが
   正しい**可能性が高い**が未検証。**さつきに HRC で同一局面を出力してもらい OC レンジを照合すること。**
   （さつきは holdemresources.net/nashicm を使える。スクショで結果をくれる）
2. **収束設定の確定**（未決着）。現在の既定 `maxIters 1000` / しきい値 `プール×0.0015` は
   今回の実測で**緩すぎる**と判明。推奨は `maxIters 8000` / `プール×0.0003` だが、
   6人卓が正確さ優先だと端末で約2分半になるため、さつきの判断待ち。
3. **BU の残差 −6.6pt の原因**（モデル差。収束不足でもMCノイズでもないと確定済み）。
   残る候補: HRC のポストフロップモデル / HRC 側の CI 設定 / 無差別境界の計上差。

---

## 6. 制約（厳守）

- **master への push は、さつきの明示的な指示があるまで禁止**（push すると Cloudflare が自動デプロイする）。
- 現在の作業は**すべて未 commit**。`git status` で確認すること。
- `.env.local` は読み書き禁止。デプロイ（wrangler）はさつきの作業。
- OCR の検証は必ず「AI 目視 vs OCR 出力」の照合で行う。
- さつきは非エンジニア。**日本語で、専門外でも分かる説明を添えること。** 数値と根拠を必ず示す。
- **計画を提示 → 承認 → 実装**の順で進める。

---

## 7. 現在の未 commit 変更（引き継ぎ時点）

```
 M package.json                                  gen:hu-wintie スクリプト追加
 M packages/solver/src/huTable.ts                classWinTieCanonical 追加
 M packages/solver/src/multiwaySolver.ts         monotonize 配線
 M packages/solver/src/nwaySolver.ts             winTie / mcSamplesFor / uniformSamples
 M packages/solver/src/pfResult.ts               monotonize 配線
 M packages/solver/test/nnTable.test.ts          単調性に合わせて期待値修正
 M packages/solver/test/nwaySolver.test.ts       相互検証の許容幅 6→13pt
?? packages/solver/src/showdownExact.ts          2人ショーダウン厳密解（新規）
?? packages/solver/src/huWinTieLoader.ts         win/tie 表ローダ（新規）
?? packages/solver/src/monotonize.ts             レンジ単調性補正 min-cut（新規）
?? packages/solver/scripts/genHuWinTieTable.ts   win/tie 表生成（新規）
?? packages/solver/artifacts/hu-wintie-169.*     生成済み表 228KB（新規）
?? packages/solver/test/monotonize.test.ts       単調性テスト5件（新規）
?? packages/solver/_bench6.ts                    既存の使い捨てベンチ（放置でよい）
```
全448テスト green / typecheck clean。

---

## 8. 調査結果（2026-09-07, Fable）— 承認待ち

**結論: 「OC以降を解かない」は不可（§2e の崩壊＝フィードバック経路）。ただし構造を使うと計算量はほぼ消える。**
試作 `packages/solver/_oc_proto_core.ts`（`mcRunner` 注入。本番コード未変更）:
1. 着順シグネチャ→ICM キャッシュ（厳密・同値）。1サンプル 4.5µs の約半分が ICM+サイドポットだった。
2. hero パスをクラス層化（各クラス固定本数）。**overcaller（3人目以降）は「他参加者の最も狭いレンジに対する HU equity 上位 K=24」だけ各40本**。未サンプルは候補中の最小値で埋める（marginal 埋めは OC 100% に崩壊＝禁止）。
3. pusher/caller パスは各クラス3本・marginal 500本（重みが小さい）。
4. 使用カード Set→ビットマスク。

| スポット (8000反復) | 本番 8並列 | 本番 単スレ | 試作 単スレ | 解 |
|---|---|---|---|---|
| 4人 CO14/BU34/SB33/BB22 | 8.6s | 36.5s | **1.6s** | CO 18.6 / BU 38.2 / SB 100（一致） |
| 6人 全員10bb | 36.4s | (~300s) | **21.7s** | 5席とも一致 |
| 6人 さつき局面 | 41.6s | — | 30.9s | UTG/HJ の差は本番自身の seed 差・GOLD(120k) と同幅＝ノイズ床 |

感度: K12 は漂う（K24 以上）。mOc20/mLow1 は CO 52.3→49.3 と漂う（既定 K24/mOc40/mLow3/sMarg500）。
App は MC が実質単スレ（main の mcRunner）かつ **winTie 未配線**（`huWinTieLoader.browser.ts` 未作成）。

## 9. HRC が 10 人でも 1 秒で解ける理由（2026-09-07 調査, さつきの「隠れたパターン」仮説は正しかった）

**公式情報（HRC ブログ 2020-02 HRC Update）**:
- 「To allow efficient calculation, the Math engine restricts the calculated game: **No more than 3 active players are allowed**, and passive card removal is not considered」
- 「EVs based on **full run-outs over all boards and all opponent hands**. The displayed EVs are perfectly reproducible」（＝厳密表・MC なし）
- 「Allowing more than three active players **drastically increases the number of possible outcomes**」「Monte Carlo mode supports up to 10 active players」「maximum number of active players can be specified (default is 3)」
- ICMIZER も同様（2+2 開発者投稿の要旨）: 「3-way までしか考えない。4-way の range vs range vs range vs range は計算不能。3 人オールインになったら残り全員はフォールドとみなす」
- 学術: Ganzfried & Sandholm (AAMAS 2008) の 3 人 jam/fold 均衡も、3 人オールインの 13 通りの着順確率を **11 カード全列挙（スート対称で削減、7 カード評価表を事前計算）** して表にし、fictitious play で解いた。

**つまり隠れたパターン = ゲームそのものを「同時オールイン最大 3 人」に切り詰め、2 人・3 人の着順分布を厳密表で引く。** 10 人卓でも到達しうるショーダウン集合は C(10,2)+C(10,3)=165 個（全集合なら 1013 個）、MC ゼロ。

**自前ソルバーで打ち切りを再現（使い捨て `_nwayTrunc.ts`, maxActive=3, 試作 MC 併用, 8000 反復）**:
| スポット | 完全ゲーム | 3人打ち切り | 時間（単スレ） |
|---|---|---|---|
| 4人 CO14/BU34/SB33/BB22 | CO18.9/BU38.2/SB100 | **同一** | 36.5s→32.9s（本番MC） |
| 6人 全員10bb | 40.9/48.4〜48.7/71.0/85.5/100 | 40.9/**50.5**/71.0/85.5/100 | 21.7s→**4.9s** |
| 6人 さつき局面 | 16.1〜17.0/29.7〜32.7/52.3/51.7/100 | 16.1/30.6/52.3/51.7/100 | 30.9s→**4.9s** |
→ 精度はノイズ幅以内（10bb 6人の HJ +1.2〜2pt が上限）、6 人は約 4〜6 倍速（集合 42→16）。**BU −6.6pt の HRC 残差は打ち切りでは説明できない**（4人は同一）。

## 10. 実装完了（2026-09-07, さつき承認「推奨通り」）— 未 commit

- `src/showdownMc.ts`: `OutcomeCache`（着順シグネチャ→ICM, 厳密同値）/ 使用カードをビットマスク化 / `estimateHeroStratified`（hero クラス固定・均等配分の層化パス）。
- `src/showdownJob.ts`: `computeShowdownMc(..., strat?)`。`StratSpec { cand, mOc, mLow, sMarg }` で層化経路、省略で従来経路。既定 `DEFAULT_STRAT = {K:24, mOc:40, mLow:3, sMarg:500}`。未評価クラスは候補最小値で埋める。
- `src/showdownExact.ts`: `rankClassesByEquityVs(opp, winTie)`（候補ランキング）。
- `src/nwaySolver.ts`: `maxActive`（**既定 3** = HRC Math / ICMIZER と同じゲーム定義）/ `stratifiedMc`（既定 true, winTie 必須）/ `ocCandidates`（既定 24）/ 適応 K（OC の最適反応が候補下位 1/4 に触れたら次 refresh で倍化）。打ち切りノードは `truncated` で決定なし（pct 0）。
- worker 経路: `nwayWorker.ts` / App `mcWorker.ts` が `strat` を転送。
- App: `huWinTieLoader.browser.ts` 新設、`solver.worker.ts` の 3 箇所の `solveMultiway` に `winTie` 配線（3〜6 人の MC 経路が 2 人厳密＋層化に）。vite build で 228KB 同梱・precache 確認。

本番経路の再現（8000 反復, 収束しきい値 0）:
| スポット | 旧 8並列 | 新 単スレ | 新 8並列 | 解 |
|---|---|---|---|---|
| 4人 CO14/BU34/SB33/BB22 | 8.6s | **1.2s** | 0.8s | CO 18.6 / BU 37.9 / SB 100（旧収束値と一致） |
| 6人 全員10bb | 36.4s | **4.9s** | 2.1s | UTG 41.8 / HJ 48.7 / CO 65.6 / BU 85.5 / SB 100（CO 65.6 は旧 GOLD 一致） |
| 6人 さつき局面 | 41.6s | **6.0s** | — | 15.8 / 29.7 / 52.3 / 52.6 / 100（ノイズ幅内） |
全 448 テスト green / typecheck clean。App は `MAX_PLAYERS=4` のまま（5〜6 人の解放はさつき判断）。

## 11. HRC 6 人照合（2026-09-07, UTG23/HJ11/CO33/BU43/SB34/BB22）と表示方式の実験

- ICM equity（EQPre/EQPost）は 6 席とも HRC と 0.01% 以内で一致。
- レンジ（17 ノード）: 平均|差| 1.26pt、11 ノードが 1pt 以内。OC は全ノード 1 クラス以内。
- 最大の差は CO PU 26.8 ↔ HRC 34.2。違う手は全て |EV| < 0.01pt（HRC だけ押す K4o〜KTo/Q3s〜Q7s は −0.000〜−0.008、私だけ押す 33〜99 は +0.002〜+0.005）＝無差別帯の数え方。
  方向の規則性（HRC は Kx/Qx を押し小ペアを押さない）は**ブロッカー効果（hero のカードが相手コールレンジの KK/AK を減らす）**の未反映が有力候補。過去の hero-only カード除去は悪化した記録あり（要再検討）。
- 表示方式の実験（`displayMode`）: 'avg'（全反復平均, 従来）6人 1.26pt / 4人 CO +1.0 ／ 'lateAvg'（後半平均）1.26 / −2.1 ／ 'evSign'（最終 EV 符号）0.99 / −2.4。
  **結論: 既定は 'avg' を維持**（均衡近似は平均戦略。BR スナップショットは無差別帯で振れる）。他 2 方式は opt-in で残す。
- 教師データ生成（nn5way）は 338/3125 点で停止中（新エンジン 8000 反復, チェックポイント済み, モニタから再開可）。

## 12. HRC 照合 2（超短スタック UTG23/HJ11/CO3/BU43/SB2/BB22, 2026-09-07）で見つかった 2 つの欠陥と修正

1. **同時バストの順位付け**（`icmEquities` に `tieBreak`）: 同一ハンドで複数人が飛んだとき、従来は均等割り
   （各 −0.5pt）だったが、実際は**ハンド開始時のスタックが大きい方が上位**（HRC も同じ）。SB 2bb の
   OC が 22.3%（HRC 1.8%）に膨れていた真因。修正後 5.0% → 最終 3.3%。
2. **層化 MC の前提崩れ**: 超短スタック局面では「誰でもコール」になり 3 人ショーダウンの到達確率が
   1〜10%、overcaller のレンジも 60% 超になる。上位 K=24 候補＋候補最小値埋めでは OC が膨れる
   （BB OC 92% ↔ GOLD 67%）。修正: (a) 到達確率 > 0.5% の集合は従来のコンボ数比例 MC、
   (b) overcaller の現在レンジ > 5% なら全 169 クラスを各 40 本（3 本では「運の良い手」に引きずられ崩壊）。
   注意: 4 人目以降の打ち切りノードは最終パスで評価して表示（AA が消えないように）。
   2bb SB が 4 人オールインに AA で降りるのは ICM 上正しい（フォールドで 3 位以上確定, ev −0.38）。

結果（8000 反復）: GOLD（均等 60k, 60s, expl 0.002）= UTG 14.9 / HJ 13.6 / CO 11.3 / BU 78.6 / SB 91.6,
BU CA vs CO 12.8, BB OC vs CO+SB 67.4 ↔ HRC 16.4 / 16.6 / 10.4 / 84.9 / 94.6, 10.1, 74.7。
本番設定（3.3s, expl 0.022）: 12.8 / 10.9 / 11.3 / 69.5 / 91.6, 14.3, 79.2。超短スタック局面は FP の
ノイズ床が高く（無差別帯が広い）、通常局面（expl 0.001〜0.003）より差が残る。
4 人 CO14/BU34/SB33/BB22 と 6 人 A は変更前と同一（18.6/38.2, 11.6/19.8/27.6）。
