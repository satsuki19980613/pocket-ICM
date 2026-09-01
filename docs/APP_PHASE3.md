# App（PWA）Phase 3 — 実装メモ

版: 2026-09-01 / 対象: `packages/app`

IMPLEMENTATION_PLAN Phase 3（アプリ / ローカル完結 PWA）の実装記録。MVP Tier 1 の
「手入力による ICM 計算フロー」を、**端末内でソルバーを実行**して実現する。

## スコープ分割

| # | 内容 | 状態 |
|---|---|---|
| **3-1a** | app 土台（Vite+React+PWA）＋ソルバーのブラウザ対応＋Web Worker で in-browser 求解 | ✅ |
| **3-1b** | 手入力フォーム → 条件確認 → エラー（§7.1, §6.5） | ✅ |
| **3-1c** | 基本の結果画面（判定・EV色バンド・13×13レンジ表・EQ・収束品質, §7.2 の一部） | ✅ |
| **3-1x** | ショーダウン MC のブラウザ Web Worker 並列化（CPU60%） | ✅ |

記録(IndexedDB=3-4)・Drill(3-6)・OCR(Phase2)・画像書き出し(Tier2)・Action tree の
全展開(3-2)は後続。モックの SNS 系画面（auth/home/thread/profile）は SPEC 削除済みのため作らない。

## 3-1b/3-1c 実装（手入力フロー）

画面遷移は `App.tsx` の状態機械 `form → confirm → solving → result / error`:

- **手入力フォーム**（`InputForm`）: 残り人数(2-6)・ブラインド・アンティ方式/額・
  各ポジションのスタック・hero 選択・hero ハンド（13×13 グリッド `HandPicker`）。
  `formModel.buildBoardState` が §3.1 BoardState を組み立て、core の zod＋
  `checkBoardStateSemantics`＋`potChecksumDelta`＋`parseHandClass` で検証。無効なら
  送信不可＋理由表示。フォームは「開始状態（全席 live・未開）」を捉える（上流アクションは
  solver が全木を解くので、結果画面のノードで扱う）。
- **条件確認**（`Confirm`）: 読み上げ＋**ポット検算の一致/不一致**を強調。修正 / 計算する。
- **結果**（`Result`, 3-1c）: hero のオープン決定を **PUSH/FOLD** で大きく表示、
  EV（実払い pt, §4 の色バンド <0.05/0.05–0.2/>0.2）、頻度バー、**13×13 レンジ表**
  （レンジ入り強調＋hero セル枠, `RangeGrid`）、レンジ表記、ICM equity(Pre/Post/Diff)、
  求解品質（`converged=false` のとき収束不十分の注記）、全ノード一覧（折りたたみ）。
- **エラー**（`ErrorView`）: 検証失敗・求解例外の理由を出して入力へ戻す。
- テスト: `formModel.test.ts`（組み立て・検証, 全人数, 異常系）/ `sampleSpots.test.ts`。

## 実機確認と重要な申し送り（速度・収束）

ブラウザ実機（単一スレッド）で 5-way・A5s・UTG・15bb を通した実測:

| 指標 | 値 |
|---|---|
| 求解時間 | **88.7s**（`maxIters=150`, `samples=22k`, 単一スレッド） |
| exploitability | 0.0725pt（`converged=false`, しきい値の約10倍） |

- **5〜6人は単一スレッドだと「遅い上に未収束」**。150 反復では境界ハンドが荒れ、
  レンジに軽度 −EV のハンドが混じる（結果画面は `converged=false` を明示して正直に扱う）。
  A5s の EV が −0.107pt（PUSH 判定なのに負）になったのはこの未収束が原因で、バグではない。
- 収束には ~1500 反復要（bench §4）が単一スレッドでは非現実的。したがって
  **ブラウザ多 Web Worker 並列化（3-1x）**を実装した（下記）。

## 3-1x ショーダウン MC のブラウザ並列化

ショーダウン MC（求解コストの本丸, `showdownMc`）を複数 Web Worker に分散する。
`solveMultiway({ mcRunner })` に**並列ランナーを依存性注入**する形にし、Node の
worker_threads プール経路（`workers`）は不変のまま、ブラウザは Web Worker プールを注入する。

### 配置（入れ子 Worker を避ける）

当初は求解 Worker が MC 下請け Worker を入れ子で spawn する設計にしたが、**Vite では
入れ子 Web Worker がロードに失敗**（空の ErrorEvent, dev/prod とも）。そこで MC プールは
**メインスレッドが所有**し、求解 Worker からの MC 要求をメインが中継する構成にした:

```
求解Worker(FP反復) ──mc要求──▶ メイン(ルーティング) ──▶ mcWorker×N(CPU60%) ──▶ 結果
        ▲                                                              │
        └──────────────────── mc結果 ◀────────────────────────────────┘
```

- `mcWorker.ts`: computeShowdownMc を呼ぶ下請け（Node の nwayWorker.ts 相当）。
- `mcPool.ts`: メインが持つ Web Worker プール（`navigator.hardwareConcurrency×0.6`）。
- `solver.worker.ts`: `mcRunner` はメインへ `{kind:'mc'}` を投げて結果を待つ。
- `solverClient.ts`: 求解 Worker と MC プールを両方メインで生成し、`{kind:'mc'}` を中継。
- 契約テスト（`nwaySolver.test.ts`）: 同一シードの `mcRunner` 注入が内蔵単一スレッド経路と
  **bit 一致**することを検証（並列でも結果が変わらない保証）。

### 実測（28コア機, CPU60%=16 mcWorker）

| N | 反復/サンプル | 求解時間 | exploitability | 収束 |
|---|---|---|---|---|
| 2 (HU) | 既定 | <1s | 〜0.001 | ✓ |
| 3 | 400 / 50k | 〜14s | 0.0136 | ほぼ床 |
| 4 | 600 / 40k | **25s（prod）** | 0.0143 | ✓ |
| 5 | 600 / 32k | 〜43s（dev） | 0.0166 | 床 |
| 6 | 500 / 24k | 〜75s（dev） | 0.0244 | best-effort |

- 5-way は並列化前 **88s / expl 0.0725** → **43s / 0.0166**（速度2倍・収束4倍改善）。
  未収束由来の「PUSH なのに −EV」の破綻も解消（A5s UTG は正しく僅差 FOLD）。
- **2〜4 人・HU は実用**（数秒〜25s, converged）。**5〜6 人は数十秒**（レビュー用途では許容だが
  SPEC §8「数秒」には未達）。さらなる短縮は Linear-Nash warm start・MC 分散低減が候補（後続）。

## 技術選定（3-1a, さつき承認済み）

- **React + Vite + TypeScript**。標準的で情報量が多く後続セッションが保守しやすい。
  vite-plugin-pwa でオフライン/manifest、Vite の Web Worker/`?url` アセットが素直。
- **PWA**: `vite-plugin-pwa`（`registerType: autoUpdate`）。`base: './'` で GitHub Pages の
  サブパス配信に対応。HU equity テーブル(.bin, 114KB)を precache に含めオフライン求解可能。

## ブラウザ内求解（最難関の技術リスク → 解決）

ソルバーは元々 Node 専用 API（`node:worker_threads`/`node:os`/`node:module`/`node:fs`）に
依存していた。これを分離し、単一スレッド経路をブラウザで安全にバンドルできるようにした
（詳細は `refactor(solver): ソルバーをブラウザ安全化` コミット）:

- `huTableCore.ts`（環境非依存の型+ビルダ）/ `huTableLoader.browser.ts`（fetch 版）。
- `huSolver` の既定テーブルローダを依存性注入化（Node は index.ts で自動登録、
  ブラウザは必ず `opts.table` を渡す）。
- `nwaySolver` のトップレベル node import を撤去。`WorkerPool` は `nwayWorkerPool.ts`
  （Node 専用）へ分離し、**変数経由の動的 import** でバンドラの静的解析を回避。
  `maxWorkerCap` は `navigator.hardwareConcurrency`（Node 21+/ブラウザ共通）。
- `package.json` の `"browser"` exports 条件で App は `index.browser.ts` を取り込む。

**求解は Web Worker 側で実行**（`solver.worker.ts` / `solverClient.ts`）し UI を固めない。
ブラウザでは `workers:0`（単一スレッド）で走り、`nwayWorkerPool` は一切参照されない
（ビルド成果物にも含まれないことを確認済み）。

## 実測（in-browser, 単一スレッド）

| 盤面 | iters/samples | 所要 | expl | converged |
|---|---|---|---|---|
| 2-way HU 10bb | FP 既定 | **0.24s** | 0.0009 | true |
| 4-way 10bb | 200 / 30k | **11.5s** | 0.0456 | false |

- HU（テーブル lookup + FP）は即応。多人数はショーダウン MC が支配的で単一スレッドだと重い。
- EQ 保存（EQPre 総和 = EQPost 総和 = pool）はブラウザでも成立を確認。
- **申し送り**: SPEC §8 の「数秒」目標には 5〜6-way で**ブラウザ多 Web Worker 並列**が要る
  （Node の worker_threads プールに相当するものを Web Worker で用意する）。3-1a は
  単一スレッドでの実証にとどめ、並列化は後続（3-1x）。対話用に iters/samples の
  既定調整でも短縮できる。

## 動かし方

```bash
npm run dev --workspace @oshihiki/app   # Vite dev（:5173）
npm run build --workspace @oshihiki/app # 本番ビルド（PWA 生成）
```

`.claude/launch.json` に `app`（:5173）を定義済み。
