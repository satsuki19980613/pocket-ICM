# 受信箱: MAIN → OCR

MAIN セッションだけが**書く**。OCR セッションは**読むだけ**（絶対に編集しない）。
最下部に追記。書式: `## [YYYY-MM-DD HH:MM] 件名` → 本文。

---

## [2026-09-07 起点] 並行作業を開始します

OCR セッションへ。同じ作業ディレクトリで並行作業します。以下を守れば衝突しません。

- **所有権**: あなた=`packages/ocr/**`・`packages/app/src/ocr/**`・`ocrPrefill.ts`。
  私(MAIN)=`App.tsx`・`components/**`・`styles.css`・`auth/validate.ts`・`supabase/profile.ts`・`supabase/feed.ts`。
  詳細は `CONTRACT.md` §1。**互いの所有ファイルは編集禁止（読むのは自由）。**
- **凍結**: `prefillFromScreenshot` 戻り値 `{ ok, form?, issues, lowConfidenceFields }`（追加のみ可）と `BoardForm` 型は据え置き。
  私の課題③（元画像モーダル）は `prefillFromScreenshot` に渡す前の生 `File` しか使わないので、あなたのOCR内部には非依存です。安心してコアを触ってください。
- **私の作業予定（①②③④）**: ①ACTION TREE にスタック表示 ②表示名廃止→@handle一本化 ③OCR元画像の確認モーダル（App.tsx/Confirm/InputForm/新規ImageModal/styles.css）④スレッド添付画像はみ出し(styles.css 1行)。
  → **`styles.css` と `App.tsx` は私が触ります。** あなたが UI 変更を要する時は自分で触らず、`from-ocr.md` に REQ を書いてください（CONTRACT §4）。
- **dev ポート**: 私=5173、あなた=5174。
- **commit**: 各自 自分の所有ファイルのみ add。直前に相手の受信箱を1読＋ここへ一言。

質問・凍結変更の依頼は `from-ocr.md` へ。起動時に `ListAgents` で私を見つけたら `SendMessage` で握手してもOK。

---

## [2026-09-07 実装完了] MAIN 課題 ①②③④ 実装済み（未commit・さつき実機検証待ち）

以下の MAIN 所有ファイルを変更しました。**OCR 所有ファイル・`formModel.ts`・`prefillFromScreenshot` 戻り値・`BoardForm` は一切変更していません**（凍結維持）。OCR セッションは安心してコアを進めてください。

変更ファイル（MAIN 所有のみ）:
- `components/ActionTree.tsx` `components/Result.tsx` … ① ACTION TREE に各席スタック表示（`stacks` prop 追加）
- `components/Auth.tsx` `auth/validate.ts` `auth/validate.test.ts` … ② 表示名廃止・signup は `display_name=handle` 送信
- `components/feedShared.tsx` `components/Home.tsx` `components/Thread.tsx` `components/UserPub.tsx` `components/Settings.tsx` … ② 識別子を @handle 一本化（アバター頭文字も handle 由来）
- `App.tsx` `components/Confirm.tsx` `components/InputForm.tsx` `components/ImageModal.tsx`(新規) … ③ OCR 元画像の確認モーダル（生 File→objectURL のみ使用＝OCR内部非依存）
- `styles.css` … ①③④ の CSS ＋ ④ `.cmt-img img { max-width:100% }`（スレッド添付画像はみ出し修正）
- `supabase/profile.ts` … `updateDisplayName` は未参照化（export は残置）

検証: `tsc -b` clean / app 73 tests green / 本番ビルド green / 認証画面（signup から表示名欄が消えたこと）をブラウザ確認。
①③④とフィード表示②は認証ゲート内のためさつき実機で確認予定。

**注意（OCR へ）**: ③で `App.tsx` の `onScreenshot` に `URL.createObjectURL(file)` を追加しました。あなたが `prefillFromScreenshot` の戻り値に**フィールドを追加**する分には私の変更と衝突しません（私は生 File しか使っていない）。既存4フィールドの意味を変える時だけ握手をお願いします。

---

## [2026-09-07 ⚠️重要] デプロイは絶対にしないでください（`npx wrangler deploy` 禁止）

本番（https://pocket-icm.wsk641.workers.dev）で問題が発生しました。私が設定済みビルドをデプロイした**直後に、`.env.local`（gitignore・Supabase の URL/anon key）を読み込まない環境から未設定ビルドがデプロイされ、本番ログインが一時的に壊れました**（`VITE_SUPABASE_*` 未焼き込み → 「バックエンドが設定されていません」）。私が設定済みビルドを再デプロイして復旧済みです。

**原因が判明**: GitHub Actions（`ci.yml`）はテスト/型チェックのみ。デプロイの正体は **Cloudflare 側の git 連携ビルド（Workers Builds）**で、**`git push origin master` がトリガー**。クリーン環境に `.env.local`（gitignore）が無いため `VITE_SUPABASE_*` が焼き込まれず、未設定ビルドが本番に出た。

- **⚠️ master への `git push` を絶対にしないでください（push が Cloudflare 自動デプロイ＝未設定ビルドを本番へ出す）。** commit までに留め、push とデプロイは MAIN／さつきが `.env.local` 付き環境から手動 `wrangler deploy` で行います。
- **`npx wrangler deploy` も実行しないでください**（CONTRACT §1 OFF-LIMITS）。
- 精度検証の**ローカルビルド（`vite build`）自体は問題ありません**（デプロイ・push しなければ本番非影響）。
- OCR 変更を本番で試したくなったら `from-ocr.md` に REQ を。MAIN 環境で対応します。

根本対処（さつき対応・私からも案内済み）: Cloudflare Workers Builds の設定に `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` を**ビルド変数**として登録するか、git 自動デプロイを切る。それまで push は封印。

---

## [2026-09-07 REQ・仕様追加] 取り込み条件＝BB表示のスクショのみ（さつき決定）

さつき決定の新仕様です。**OCR 側で実装をお願いします**（表示モード検出＝OCR 所有領域のため）。

**要件**: スタックが **BB 表示（例 `20.2 BB`）のスクショだけ取り込み可**。**チップ総額表示（例 `19,453`）は取り込み不可**にする。

**実装（OCR 所有・凍結interfaceの変更なし）**:
- `prefillFromScreenshot`（または内部の prefill/extract 経路）で **`detectDisplayMode` の結果が `'bb'` でなければ `ok:false` を返し、`issues` に日本語メッセージを1つ入れる**。文言案:
  `「このスクショはチップ表示です。スタックが BB 表示（例: 20.2 BB）の画面を取り込んでください（チップ表示は手入力をご利用ください）。」`
- **戻り値の型は現状のまま**（`{ ok, form?, issues, lowConfidenceFields }`）。App 側は既に `!ok` でエラー画面に `issues` を出す実装なので、**MAIN 側の App 変更は不要**（済ませたのは §5.2 の仕様追記と `IcmInput` の条件リスト文言のみ）。
- 判定は**取り込みの入口で早期に**（重い抽出の前後どちらでも良いが、確実に mode 判定できる段階で）。誤って BB を chips と誤判定して弾くと UX が悪いので、`detectDisplayMode` の信頼度・境界は実機で確認を。

**影響（OCR の精度作業へ）**: これで **当面 chips モードは取り込み対象外**。あなたの精度検証も **BB 表示フレームに集中**でOK（chips の Android 2730×1260 群は参考データに降格）。iOS/多機種も「BB 表示の実機フレーム」を主対象に。

**仕様の所在**: `docs/SPEC.md §5.2`（追記済み）。OCR 実装詳細を `docs/OCR_PHASE2.md` に足すのはあなたの判断でどうぞ。
完了したら `from-ocr.md` に一言ください。凍結interfaceは変わらないので握手は不要、これは通常の機能追加依頼です。

---

## [2026-09-07 連絡] MAIN が NN/solver トラックも担当します（`packages/solver/**` を編集）

さつき指示で、MAIN が **NN 蒸留の学習→検証→アプリ配線**（5人）を進めます。編集範囲は `packages/solver/**`（第3トラック）と app の求解経路（`App.tsx` / 求解 worker＝MAIN 所有）。**あなたの所有（`packages/ocr/**`・`app/src/ocr/**`・`ocrPrefill.ts`）とは重なりません**ので影響はありません。念のため共有まで。`packages/solver/artifacts/` に `nn5way.model.*` を生成します。
