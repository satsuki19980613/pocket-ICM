# PLAN — OCR セッション（認識精度の強化）

> このファイルは OCR セッションが最初に読む起動ブリーフ。まず `CONTRACT.md` を読み所有権と凍結ルールを守ること。
> **あなた（OCR セッション）の所有は `packages/ocr/**`・`packages/app/src/ocr/**`・`packages/app/src/ocrPrefill.ts` のみ。**
> UI（`App.tsx` / `components/**` / `styles.css`）は MAIN 所有＝**編集禁止**（読むのは可）。

## ミッション
さつき報告: **現状の OCR 精度では実用に耐えない。** 目標は実スクショ（プリフロップ終了フレーム）からの
`BoardForm` プリフィル精度を実用水準へ引き上げること。手段はテンプレ拡充・プロファイル較正・
認識コアの改善（＝「トレーニング精度」の向上）。粘り強い反復を前提とする。

## 起動時にやること
1. `CONTRACT.md` を読む（所有権・凍結・連絡）。
2. `ListAgents` で MAIN セッション名を確認。`from-main.md` を読む。
3. `git status` で作業ツリー確認（NN 由来の `packages/solver/artifacts/nn5way.*` や `_bench*.ts` は第3トラック＝触らない）。
4. まず**現状精度の実測から**。憶測でいじらない。

## 精度検証の鉄則（[[ocr-accuracy-verification]]）
**必ず「AI 目視 vs OCR 出力」を照合してから結論する。** AI 目視ラベルも誤るので双方向で突き合わせる
（過去、目視の J♥→J♦ 誤りを OCR が捕捉した実績あり）。フレーム分類（CLEAN preflop のみが有効対象）に注意。

## 現状資産（authoritative は各ドキュメント）
- 設計: `docs/OCR_PHASE2.md`。人数別レイアウト・単位2モード（chips / BB小数）・アクション語・カード裏状態など。
- 較正ハーネス（依存ゼロ, `packages/ocr/scripts/`）: `verifyFrame.ts`（正解付き照合）・`tuneField.ts`（領域nudge×閾値グリッド探索）・
  `digitsTool.ts`・`extractFrame.ts`・各 `probe*.ts`。**src コードをそのまま使う**（単一の真実）。
- テンプレ（確定版は `packages/ocr/assets/`, 実験は `local-fixtures/` = gitignore）。
- 既知の到達点: 数字 chips 6人 CLEAN 85/88(96.6%)、カード rank/suit 独立キャプチャ良好、blinds/street/D ボタン/アクションタグ実装済み。
- **既知の弱点候補**: BB小数モードのベット/pot 領域が chips 座標で低conf、hero rank 精度 ~80%、人数別(2-5)レイアウト未検証、
  発光/遮蔽フレームの低conf。まずどれが「実用不可」の主因かを実測で切り分ける。

## 触ってよい範囲（再掲・OCR 所有）
```
packages/ocr/**                    src / assets / scripts / local-fixtures / tests
packages/app/src/ocr/**            decodeImage / bundledTemplates / prefill / screenshotPrefill / prefill.test
packages/app/src/ocrPrefill.ts     boardStateToForm（出力は必ず有効な BoardForm）
```

## 凍結・非改変（CONTRACT §2）
- **`prefillFromScreenshot(file)` の戻り値**は `{ ok, form?, issues, lowConfidenceFields }` の4フィールドを**保つ**
  （MAIN がこれに依存）。**追加フィールドは可**、既存の意味・型は不変。追加時は `from-ocr.md` に一言。
- **`BoardForm` 型**（`formModel.ts`, MAIN custodian）は変えない。認識結果は既存フィールドに詰める。
  どうしても項目追加が要るなら CONTRACT §4 の握手（`from-ocr.md` に REQ → MAIN の ACK 待ち）。
- `data/cardTypes.ts`（Suit/SampleCard）も凍結。
- **UI 変更が必要になったら**（例: OCR入口 IcmInput の文言や、低信頼表示の見せ方）自分で `components/**` を触らず、
  `from-ocr.md` に REQ を書いて MAIN に依頼する。

## dev / ビルド
- dev サーバは **:5174**（`vite --port 5174`）。MAIN の :5173 と衝突させない。
- OneDrive の Vite 固着に注意（`.vite` 削除＋再起動）。
- コミットは OCR 所有ファイルのみ `git add`、接頭辞 `feat(ocr)/fix(ocr)`。commit 直前に `from-main.md` を1読＋一言。
- `tsc -b` + OCR テストを通す。凍結型に触れない限り MAIN の途中状態に型依存は生じない。

## 連絡
- 書くのは `from-ocr.md`（append-only, 最下部に追記）。読むのは `from-main.md`。**相手の受信箱は編集しない。**
- 節目（着手前・凍結変更依頼・commit 直前・完了時）に MAIN の受信箱を1読。緊急は `SendMessage`（決定は受信箱に残す）。

## DoD
- 実 CLEAN フレーム群で BoardForm プリフィル精度を**実測で提示**（AI目視照合の証跡つき）。
- 改善前後の数値を `from-ocr.md` に記録。`prefillFromScreenshot` 戻り値・BoardForm は非破壊。
- tsc/OCR テスト green・本番ビルド green。push/デプロイはさつき指示後。
