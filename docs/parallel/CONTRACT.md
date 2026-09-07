# 並行作業 契約（CONTRACT）— MAIN × OCR

2 つの Claude セッションが同じ作業ディレクトリで**同時**に作業する。衝突ゼロの前提は
**「ファイル所有権が排他」**であること。これが唯一絶対のルール。

- **MAIN セッション** … OCR 以外の UI/仕様修正（課題 ①②③④）。計画は `PLAN_MAIN.md`。
- **OCR セッション** … OCR 認識精度の強化（トレーニング/テンプレ/プロファイル較正）。計画は `PLAN_OCR.md`。

連絡は append-only の受信箱 2 本（下記）＋ 起動時の `ListAgents`→`SendMessage`。

---

## 0. 最重要ルール（両者厳守）

1. **自分の所有ファイルしか編集しない。** 他方の所有ファイルは読むのは自由、書くのは禁止。
2. **FROZEN（凍結）interface/型は握手なしに変えない。** 変えたい時は §4 の手順。
3. **コミットは自分の所有ファイルだけを明示 add。** `git add -A` 禁止（他方の作業中ファイルを巻き込むため）。
   スコープ接頭辞を分ける：MAIN=`feat(app)/fix(app)`、OCR=`feat(ocr)/fix(ocr)`。
4. **同時 commit をしない。** `git commit` は一瞬で終わるが `.git/index.lock` が競合する。
   コミット直前に相手の受信箱を見て「今 commit する」と一言書く／SendMessage する運用でよい（数秒の話）。
5. **dev サーバのポートを分ける。** MAIN=5173（既定）、OCR=5174（`vite --port 5174`）。
6. **OneDrive 保存規律。** 保存直後に別セッションが同ファイルを触ると OneDrive が競合コピー（`… の競合コピー`）を作ることがある。
   所有権が排他なら同一ファイルの同時編集は起きない設計。念のため各自 `git status` に見慣れぬ複製が出たら即共有。

---

## 1. ファイル所有権マップ

### MAIN が所有（OCR は編集禁止）
```
packages/app/src/App.tsx
packages/app/src/styles.css
packages/app/src/components/ActionTree.tsx
packages/app/src/components/Result.tsx
packages/app/src/components/ResultCard.tsx
packages/app/src/components/Auth.tsx
packages/app/src/components/Settings.tsx
packages/app/src/components/Home.tsx
packages/app/src/components/Thread.tsx
packages/app/src/components/UserPub.tsx
packages/app/src/components/feedShared.tsx
packages/app/src/components/Confirm.tsx
packages/app/src/components/InputForm.tsx
packages/app/src/components/IcmInput.tsx
packages/app/src/components/ImageModal.tsx   ← 新規（課題③）
packages/app/src/auth/validate.ts
packages/app/src/auth/validate.test.ts
packages/app/src/supabase/profile.ts
packages/app/src/supabase/feed.ts
（上記以外の packages/app/src/components/** と非OCRのapp配下も MAIN）
```

### OCR が所有（MAIN は編集禁止）
```
packages/ocr/**                          （src / assets / scripts / local-fixtures / tests すべて）
packages/app/src/ocr/**                  （decodeImage.ts / bundledTemplates.ts / prefill.ts /
                                           screenshotPrefill.ts / prefill.test.ts）
packages/app/src/ocrPrefill.ts
packages/app/src/ocrPrefill.test.ts
```

### FROZEN-SHARED（凍結・両者とも握手なしに変更不可）
```
packages/app/src/formModel.ts            型 BoardForm・buildBoardState・defaultForm（custodian=MAIN）
packages/app/src/data/cardTypes.ts       型 Suit / SampleCard（custodian=MAIN）
packages/app/src/solverProtocol.ts       型 SolveResultDto ほか（custodian=別トラック=触らない）
prefillFromScreenshot の戻り値型          （実体 screenshotPrefill.ts / custodian=OCR・追加のみ可）
```

### OFF-LIMITS（このラウンドでは両者とも触らない＝第3トラック）
```
packages/solver/**                        NN 蒸留・ソルバー（別作業）
supabase/**（Edge Function / migrations） 課題②はバックエンド非改変で通す方針。必要になれば §4 で握手し MAIN が担当。
```

---

## 2. 凍結 interface の具体（この形を保つ）

- **`BoardForm`**（`formModel.ts`）… 手入力とOCRプリフィルの両方が使う共通型。**フィールドの追加/削除/改名は禁止**。
  このラウンドの MAIN 課題①②③④は BoardForm を一切変えない。OCR も認識結果は `boardStateToForm`（OCR所有）内で
  既存 BoardForm に詰めるだけ。どうしても項目追加が要るなら §4。

- **`prefillFromScreenshot(file: File)`**（`packages/app/src/ocr/screenshotPrefill.ts`, OCR所有）
  戻り値（現状）:
  ```ts
  Promise<{ ok: boolean; form?: BoardForm; issues: string[]; lowConfidenceFields: string[] }>
  ```
  **MAIN(App.onScreenshot) はこの4フィールドだけに依存する。OCR は追加フィールドのみ可**（既存4つの意味・型は不変）。
  MAIN の課題③（元画像モーダル）は `prefillFromScreenshot` に**渡す前の生 `File`** だけを使うので、この戻り値には非依存。

- **`boardStateToForm(state): BoardForm`**（`ocrPrefill.ts`, OCR所有）… 出力は常に有効な BoardForm であること。

---

## 3. 連絡チャネル

- **受信箱（durable・append-only）**
  - `docs/parallel/from-main.md` … MAIN だけが**書く**、OCR が**読む**。
  - `docs/parallel/from-ocr.md`  … OCR だけが**書く**、MAIN が**読む**。
  - 書式: 一番下に追記。`## [YYYY-MM-DD HH:MM] 件名` → 本文。**相手の受信箱は絶対に編集しない**（読むだけ）。
- **リアルタイム（任意）**: 各セッションは起動時に `ListAgents` で相手セッション名を確認し、
  握手や緊急連絡は `SendMessage({to, message})`。**ただし決定事項は必ず受信箱にも残す**（SendMessage は揮発）。
- **確認頻度**: 節目（着手前・凍結変更の依頼時・commit 直前・完了時）に相手の受信箱を1回読む。ポーリング常駐は不要。

---

## 4. 凍結 interface を変えたい時（握手プロトコル）

1. 変更したい側が**自分の受信箱**に `## [時刻] REQ: <対象> を <どう> 変えたい / 理由` を書く（＋SendMessage で通知）。
2. 相手は**自分の受信箱**に `## [時刻] ACK-REQ: <対象> OK`（または NG＋代案）を書く。
3. **両者の受信箱に ACK が揃ってから**、custodian が変更を実装しコミット。
4. 変更後、custodian は `CONTRACT.md` の §2 を更新（このファイルの編集は「変更を実装する側」が行い、直後に相手へ通知）。

握手が済むまで、凍結対象は**現状の形のまま**。片方が待つ間はモック/仮値で先行できる。

---

## 5. ビルド/テスト運用

- 各自 `tsc -b` を通してからコミット。落ちた原因が**相手の作業中ファイル**なら、それは想定内（未コミットの相手変更）。
  自分の所有範囲だけで型が閉じるように書く。凍結型に触れない限り、相手の途中状態に型依存は生じない。
- `npm test` は全パッケージ横断で走る（読み取りのみ）。テスト**ファイルの編集**は所有権に従う（OCRテスト=OCR、appテスト=MAIN）。
- 最終マージ前に**両者そろって** `tsc -b` + 全テスト green + 本番ビルドを確認（§ PLAN 各末尾の DoD）。

---

## 6. 現在の起点

- ブランチ: `master`（origin と同期・未pushコミット 0）。両セッションとも master 上で作業し、
  自分の所有ファイルだけを小さくコミット。**push とデプロイはさつきの指示後**（[[deploy-url]] は本番のため）。
- 直近の完了: NN 5人教師データ生成（`packages/solver/artifacts/nn5way.train.*`）＝第3トラック。両セッションとも触らない。
