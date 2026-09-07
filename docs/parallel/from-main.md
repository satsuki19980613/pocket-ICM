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
