# App（PWA）Phase 3 — 実装メモ

版: 2026-09-01 / 対象: `packages/app`

IMPLEMENTATION_PLAN Phase 3（アプリ / ローカル完結 PWA）の実装記録。MVP Tier 1 の
「手入力による ICM 計算フロー」を、**端末内でソルバーを実行**して実現する。

## スコープ分割

| # | 内容 | 状態 |
|---|---|---|
| **3-1a** | app 土台（Vite+React+PWA）＋ソルバーのブラウザ対応＋Web Worker で in-browser 求解 | ✅ |
| 3-1b | 手入力フォーム → 条件確認 → エラー（§7.1, §6.5） | 未 |
| 3-1c | 基本の結果画面（判定・EV・レンジ表・EQ・収束品質, §7.2 の一部） | 未 |

記録(IndexedDB=3-4)・Drill(3-6)・OCR(Phase2)・画像書き出し(Tier2)・Action tree の
全展開(3-2)は後続。モックの SNS 系画面（auth/home/thread/profile）は SPEC 削除済みのため作らない。

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
