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

---

## [2026-09-08 REQ・重要] 実機で6人卓が5人と誤認識＝在席判定がスタック読取に依存（要・独立在席検出）

さつきが**実機iPhoneの6人卓スクショで検証→アプリが5人と誤認識**（求解の人数が狂う重大バグ）。MAIN が根因を特定しました。**OCR所有領域の修正**をお願いします。

### 根因（確定）
- `extract.ts:152` `const occupied = Number.isFinite(stack.value);` → **在席（occupancy）が「スタック数値を読めたか」だけで決まる**。ある席のスタックが `NaN` だと `empty` 扱い→ `positionDerivation.ts` の `playersLeft = occupied.length` から**その席が丸ごと消え、6→5**になる（folded席でも本来は在席カウントすべき）。
- `cardState.ts:8-10` のコメント通り、カード色だけでは **folded と empty を分離できない**ため現状はスタック有無を代理にしている＝**既知の妥協が実害化**。

### 再現の手掛かり（要調査）
- 該当フレームは既存GT **`E4073E5F`（1792×828＝iPhone XR/11相当）**。**ハーネスでは playersLeft=6・100%で通る**のに**実機アプリで5人**＝ハーネスと実機の乖離。
- 濃厚な仮説: **さつきの実機が1792幅と違う機種**（新しめのiPhoneは幅2532〜2868）。`prefill.ts:59` `img.w >= 2400` で**Androidプロファイル誤選択**、または別アスペクト比で `FULL_FRAME`→2730×1260 スケールが歪み、1席のスタック矩形がズレて `NaN`。`decodeImage.ts` はネイティブ解像度そのまま渡す（リサイズ無し）。
- さつきに機種＋フルサイズ実機スクショを `local-fixtures/` へ追加依頼中（届いたらGT追加して再現を）。

### 推奨修正（本丸）
1. **在席をスタック読取から切り離す**: ネームプレート/アバター等の**独立した positive 在席信号**を新設し、スタック `NaN` でも席は維持。読めないスタックは `lowConfidenceFields` で確認画面に強調（席は消さない）。
2. **機種解像度対応**: `img.w>=2400` の二値分岐が実機の中間解像度/別アスペクトを取りこぼしていないか検証。iOSプロファイルは実機2枚較正＝過学習の懸念（あなたのノート既述）。届く新フレームで再較正を。

### MAIN側で入れた安全網（実害の即時停止・OCRに依存しない）
- Confirm確認画面（MAIN所有 `Confirm.tsx`/`App.tsx`）に**「検出人数」ブロック＋2〜6のワンタップ修正**を追加（写真取り込み時のみ）。OCRが1席取りこぼしても、ユーザーが人数を選び直して席を補える＝**誤った人数で黙って解くのを防止**。凍結interface不変・App/components のみ。
- これは応急。**正しい自動検出（上記1）はOCR側で必要**です。

**凍結interface `{ok,form?,issues,lowConfidenceFields}`** は現状維持で足ります。もし「取りこぼした物理席の情報」を確認画面に渡したい場合は**追加フィールドの相談（握手）**をください。完了・進捗は `from-ocr.md` へ。

---

## [2026-09-08 検証済み設計] 在席＝黄色い名前で判定・名前中心でスタックをアンカー（さつき発案・MAINがAI目視で確認）

さつきの発案を MAIN が**実フィクスチャ切り出し＋AI目視で検証**。**両機種で成立**を確認したので、本丸修正の確定設計として共有します（実装はOCR所有）。

**検証結果（AI目視, E4073E5F iPhone 6席＋Android Screenshot_20260901-142820）**:
- **非hero席の名前は必ず黄色**。TL じゃむりんちょ / TC うさまる（ピンク強調プレート）/ TR 誤射姫サクラ（青強調）/ BR さつき（暗）/ BL KShoutOwl すべて黄色。**プレート強調色に依らず名前色は不変**。Android「おてもやん」も黄色＝**機種非依存**。
- **名前はスタックの直下・同じ横中心**（銘板中央）。スタックは名前中心の真上。両機種で同レイアウト。
- **hero席のみ例外**（金チェッカープレート＋赤名 "ri"）。ただし hero は視点席＝常に在席・カード表向き・金プレートで自明に特定可。

**設計（推奨・OCR実装）**:
1. **在席検出**: 各席のローカル領域で「黄色い横長テキストラン（名前）」を探し、**在れば occupied / 無ければ empty**。スタック読取から完全独立＝ NaN でも席は消えない（6→5 の根治）。hero は従来通り常に occupied。
   - 黄色判定の目安（実測レンジ）: R>150,G>130,B<120,|R-G|<70,R-B>60。名前は連続ランなので単発ノイズと分離しやすい。
2. **スタックのアンカー**: 見つけた**名前ランの横中心＋上端**から、スタック矩形を相対配置（名前高さでスケール）。機種ごとの固定矩形（IOS_6MAX の実測2枚較正＝過学習）を**自己位置決め**に置換でき、解像度/アスペクト差に強くなる（img.w>=2400 二値分岐の脆さも緩和）。
   - 移行は段階的でOK: まず(1)の在席だけ黄色名に替えれば 6→5 は止まる。(2)のアンカー化は精度向上として続けて。

**証拠**: MAIN が切り出した銘板 crop を確認済み（seat_TL/TC/TR/BR/BC/BL・and_TL）。必要なら同手順で再現可能（pngCodec + プロファイル stack 矩形中心の下を切る）。一時スクリプトは削除済み（OCR所有 scripts は不変）。

握手不要（凍結interface不変）。実装方針の相談があれば from-ocr.md へ。

---

## [2026-09-08 MAINが accuracy.ts をアンカー経路にパリティ修正＋iOS action 実バグを報告]

さつき指示「既知のアンカー方式バグを修正」で MAIN が検証・対応。**本番実行時のアンカーバグは MAIN 所有には無し**（占有NaN→stack0は buildBoardState が stack<=0 で弾く＝黙って0で解けない）。以下は OCR 所有領域なので申し送ります。

### ① 私が修正: `scripts/accuracy.ts` を本番アンカー経路に一致（検証パリティ）
- **バグ**: accuracy.ts の抽出が旧・固定座標（`extractRawReadsAuto` CHIPS_6MAX/IOS_6MAX）のままで、本番 `prefill.ts`（`extractAnchored` 主）と別経路を測っていた＝**アンカー経路の回帰を主ハーネスが見逃す**。コメントも「本番 prefill.ts と同じ」と陳腐化。
- **修正（OCR所有ファイルだがさつき指示で MAIN が実施）**: 既定を `extractAnchored`（throw時のみ旧経路にcatchフォールバック＝prefill.ts と同一）に。旧経路比較用に **`--legacy`** フラグを追加（`--auto` は `--legacy` 時のみ有効）。tsc緑。
- **実測（アンカー経路・私が独立実行）**: Android GT **判定100%(20/20)・有効受理100%・棄却100%**。iPhone GT **occupancy/stack/playersLeft/verdict/heroPos/pot/heroHand/blinds/ante 全100%**。**本番相当は無回帰**。
- 注意: 「完全一致」は Android 70%/iPhone 0% に見えるが、内訳は下記②③のノイズ。**判定と求解に効く項目は全一致**。

### ② iOS action = fold 誤検出（実バグ・OCR画像チューニング要）
- iPhone GT で **action 58.3%(7/12)**: 非hero席が `none`（アクティブ/ブラインド投函）なのに **fold 誤検出**（E4073E5F TL/BL, EC7CD106 TL/TC/BL）＋連動で bet 0。原因は**アンカー抽出が機種別 `handActive` 指標(iOS=strong)を選べず** Android の bright 指標で判定（あなたの cutover ノート「iOS action cosmetic 後退」）。
- **現状は求解に非伝播で安全**（誤検出席が BB/SB＝reconstructSpot が folded でも blindOb で rootStack 復元→verdict/stack/playersLeft 100%）。だが**iOS でアクティブな all-in 非ブラインド席が fold 誤検出されると root が狂う潜在リスク**。`anchorAction.ts`/`cardState.ts` で iOS の strong 指標を選べるように（アンカーは解像度非依存で機種不明＝機種非依存な指標 or 両対応判定が要る）。**OCR所有＝あなたの領域でお願いします**。

### ③ 棄却(chips)フレームの read 採点アーティファクト
- accuracy.ts の「完全一致」が **棄却される chips フレームのゴミ read 値まで採点**（142820等 chips ○=判定は正しく棄却だが read 24/32）。旧経路は CHIPS_6MAX で chips も読めたので高得点に見えていただけ。**棄却フレームは field 採点から除外**するのが妥当（メトリクス設計＝OCR判断）。

握手不要（interface不変）。②③はあなたのハーネス/画像知見で。実機の失敗スクショ入手時に②の iOS 較正も併せて。
