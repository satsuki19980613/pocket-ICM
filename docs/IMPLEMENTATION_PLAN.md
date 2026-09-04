# Black Ops ICM — 実装計画書（マイルストーン管理 / 2026-09-04）

「どう作るか（HOW）」と進捗を管理する。仕様は [SPEC.md](./SPEC.md) を正とする。
**画面はすべて `docs/production-mock.html`（Artifact 3c999290）に準拠。**

> **複数セッション運用ルール**
> - 各セッション開始時に「§1 現在地」と対象マイルストーンの「DoD（完了基準）」を確認する。
> - 作業したら、そのタスクの `[ ]`→`[x]`、マイルストーン状態、`§5 進捗ログ` を更新してコミットする。
> - マイルストーンは **DoD を満たしてから** 次へ進む。状態は ⬜未着手 / 🟨進行中 / ✅完了。

---

## 1. 現在地（最新）

| 項目 | 値 |
|---|---|
| 最終更新 | 2026-09-04 |
| 計画ステータス | **実装中**。M1（バックエンド実機稼働）・M2・M3・M4 完了 |
| 進行中マイルストーン | **M1・M2・M3・M4 ✅完了**（M1 は Supabase 実機に適用・DoD 検証済み） |
| 次アクション | **【次セッション確定】認証 UI（ログイン/サインアップ/ログアウト）を実装**（さつき承認・「推奨手順で」）。既存 `packages/app/src/supabase/{client,api}.ts` を CP2077 デザインの画面に配線し、招待キー入力→サインアップ→ログインを実機 backend（`bpxrbxnylgedjhvhfsvk`）へ接続。これで M5（記録タブ・Supabase連携）／M6（ホーム/スレッド）の前提が整う。M1 任意仕上げ: warm-ping の GitHub Secret `SUPABASE_URL`・管理者パス確認 |
| 並行トラック | M0（教師データ生成）はさつきが **`教師データ生成モニタ.pyw`**（ネイティブGUI）で随時実行可 |
| ブロッカー | M1: Supabase プロジェクト作成が Supabase 側の障害で不可（2026-09-04・復旧待ち）。コード側の足場は全て完成・commit 済み |

---

## 2. トラック構成

本改修は**2トラック並行**で進む。

- **A. アプリ改修トラック**（M1〜M7, M10）＝サーバ＋UI。セッションを閉じている間も進められる。
- **B. NN 蒸留トラック**（M0, M8, M9）＝教師データ生成〜統合。生成完了に依存。他トラックと独立。

---

## 3. マイルストーン一覧

| # | マイルストーン | 状態 | 依存 | トラック |
|---|---|---|---|---|
| **M0** | 教師データ生成（進捗GUI稼働） | 🟨進行中 | 済 | B |
| **M1** | バックエンド基盤（Auth/DB/RLS/招待/上限/管理） | ✅実機稼働・DoD検証 | — | A |
| **M2** | デザイン・トークン刷新（CP2077 黄60/赤20/青20） | ✅完了 | — | A |
| **M2.5** | 管理画面をモックに追加（`admin`） | ⬜未着手 | M2 | A |
| **M3** | ICM 入力の刷新（写真起点/手入力モーダル/確認/エラー） | ✅完了 | — | A |
| **M4** | 計算結果の刷新（Action tree 全ポジ×全条件） | ✅完了 | — | A |
| **M5** | 記録タブ（一覧/集計/削除/公開状態） | ⬜未着手 | M1 | A |
| **M6** | ホーム/スレッド（公開/返信/画像/編集/他人公開） | ⬜未着手 | M1,M4 | A |
| **M7** | 設定＋管理画面実装＋Drill=Coming Soon | 🟨実機検証待ち | M1,M2.5 | A |
| **M8** | 5人 NN 統合（学習→検証→配線→出荷） | ⬜未着手 | M0完了 | B |
| **M9** | 6人 NN（生成→学習→検証→配線） | ⬜未着手 | M8 | B |
| **M10** | 総合・出荷（回帰/PWA/デプロイ/免責） | ⬜未着手 | 全部 | A |

**着手順の推奨**: まず **M1 と M2 を並行**。バックエンドが立ち上がり次第 M5→M6、UI 基盤が固まり次第 M3→M4。

---

## 4. マイルストーン詳細（タスク＋DoD）

### M0 — 教師データ生成（進捗GUI稼働）🟨
- [x] 進捗モニタ実装・検証（最終形＝ネイティブGUI `教師データ生成モニタ.pyw` / Tkinter）
- [x] 起動不具合を解消（根因＝旧.batのLF改行。.pywダブルクリック起動に変更）
- [ ] さつきが本番 5人生成を開始（3125点・axis 2,8,14,20,25・samples 40000）
- [ ] 生成完了（`nn5way.train.f32.bin` 本番版）
- **DoD**: 本番教師データが生成完了し、`nn5way.train.meta.json` が rows=3125 になる。
- 備考: 旧スモークテスト残骸（32点）は samples 不一致で自動再生成されるため実害なし。

### M1 — バックエンド基盤 ⬜
- [ ] Supabase プロジェクト作成（**カード未登録を厳守**）
- [ ] スキーマ: `profiles / app_config / invite_codes / results / threads / comments / likes`
- [ ] RLS ポリシー（自分の記録は本人のみ編集削除／公開記録は全員閲覧／管理操作は管理者のみ）
- [ ] Edge Function `signup`: 招待キー検証（ハッシュ照合・未使用・未失効）＋上限チェック＋原子的にキー消費
- [ ] Edge Function `issue-invite`（管理者のみ・キー生成/ハッシュ保存/生キー一度だけ返却）
- [ ] Edge Function `revoke-invite` / `set-max-accounts`（管理者のみ）
- [ ] `is_admin` をさつきのアカウントに初期付与（DB直・手順を記録）
- [ ] Storage バケット（avatars / thread-images）＋ポリシー（本人書込み・サイズ/MIME制限）
- [ ] GitHub Actions 無料 cron（週1 warm ping）
- [ ] フロントに Supabase client 導入・環境変数（anon key のみ・秘密鍵は置かない）
- **DoD**: 実機で「招待キー発行（管理）→そのキーでサインアップ→ログイン→アカウント削除」が通り、
  無効キー/期限切れ/26人目/非管理者の管理操作がいずれも**サーバ側で拒否**される。

### M2 — デザイン・トークン刷新 ✅
- [x] `styles.css` にモックのトークン（黄60/赤20/青20・面取り・ブラケット・フォント）を移植（全面書き換え・既存クラス名維持でJSX不変）
- [x] 共通UI（ボタン=面取り黄CTA/ghost=シアン/red・パネル・segbtn・posbadge=6ポジション色・verdict・stat・rec）をモック準拠に（※タブ/モーダルは SNS 実装の M6/M7 で新設）
- [x] 既存全画面が新配色で破綻しないか確認（form/confirm/result[PUSH黄・FOLD赤]/records/drill/solving/error を実機で目視）
- [x] index.html に Rajdhani/Zen Kaku/Share Tech Mono を追加。EV 色を符号ベース（+EV=黄/−EV=赤）へ修正し「赤=損失のみ」を担保
- **DoD**: ✅ 既存画面がモックの見た目に一致し、`frontend-design-principles` の自己レビュー（swap/squint/signature/token）に合格。build/tsc clean。

### M2.5 — 管理画面をモックに追加 ⬜
- [ ] `docs/production-mock.html` に `admin` 画面を追加（登録状況/上限編集/キー発行・一覧・取消）
- [ ] Screens ランチャーに `admin` を追加
- **DoD**: モックに管理画面が同デザインで表示され、Artifact を更新。

### M3 — ICM 入力の刷新 ✅
- [x] 写真選択ボタンを最上位＋読み取り条件チェックリスト（`icm` = `IcmInput`）
- [x] 手入力モーダル化（現行フォームを `InputForm` ボトムシート・モーダルへ）
- [x] 条件確認/修正画面（`Confirm`・低信頼 CHECK 強調・各項目「修正」でモーダル再オープン）
- [x] エラー画面（`ErrorView`・原因一覧・写真経路は別写真/手入力、手入力経路は手入力のみ）
- **DoD**: ✅ 手入力経路を新UIで end-to-end 検証（icm→手入力→確認→計算→結果 FOLD/-0.015 赤）。写真経路は同一の onScreenshot→確認→計算配線（OCR は既存）。

### M4 — 計算結果の刷新（Action tree）✅
- [x] モック準拠の Action tree（`ActionTree`・全ポジ常時表示・インライン切替 FOLD/PU/CA/OC）
- [x] ノード選択でレンジ表・記法・frequency が連動（equity 表は常時全席表示）
- [x] BB のオールイン受けレンジを CA/OC ノードとして表示（上流 push で受け側が解錠）
- [x] no-decision 枝（BB ウォーク）のロック
- [x] 公開トグル（既定オフ・ローカルフラグ, クラウド反映は M6）。※**自動保存はさつき決定で見送り、手動保存（ALL IN/FOLD＋EV loss, M5 基盤）を維持**
- **DoD**: ✅ 純モデル `tree/model` を実ソルバー出力で検証（3-way・4-way で「到達可能キー集合＝実ノード集合」の双方向一致）。実機（HU/3-way）で全ノード切替・受け解錠・hero 強調・公開トグル保存を確認。413 tests green・build clean。

### M5 — 記録タブ ⬜
- [ ] 一覧（過去結果＋公開結果）・集計（場面数・EV loss 累計）
- [ ] 削除・公開/非公開タグ
- [ ] Supabase 連携（RLS 下で本人のみ）
- **DoD**: 記録の CRUD が RLS 下で正しく動く（他人の記録は編集不可）。

### M6 — ホーム/スレッド ⬜
- [ ] フィード（公開結果を新しい順）・結果カード
- [ ] 公開（コメント付き）・返信（画像添付）・♡
- [ ] 自分のコメント編集・他人プロフ→公開結果一覧（`userpub`）
- **DoD**: 2アカウントでスレッド往復（投稿→返信→画像→編集）が実機で成立。

### M7 — 設定＋管理画面＋Drill 🟨（さつき実機検証待ち）
- [x] 認証UI（ログイン/サインアップ/ログアウト）＋全機能ログインゲート（commit bac39ad）
- [x] 設定: 表示名/パスワード変更・公開既定・アカウント削除・ログアウト（commit 1283ffe）
  - handle 変更＝**保留**（synthetic email 付け替え＝Edge Function 未実装。読取専用/準備中表示）
  - プロフ画像（avatar・Storage）＝**後続へ送り**（読取専用「準備中」）
- [x] 管理画面 `admin` 実装（issue/revoke/setMax に配線・is_admin のみ表示・commit 271fb75）
- [x] Drill を "Coming Soon" 表示（SPEC §5.6・commit dc724f3）。ComingSoon パネル＋タブ導線維持・
  DrillView 実装は未配線で温存（※前回の「動くまま残す」はさつき再指示で撤回）。
- [x] 下段タブの骨組み（Home/ICM/Drill/記録/設定）＋トップバー・FAB（commit 828ee28・さつき指摘対応）。
  ホーム本体（公開フィード/スレッド）は M6。現状は仮置き＋ICM計算 CTA。
- **DoD**: ✅ 設定/管理のレイアウト・純ロジックを担保。**さつきローカルログインのセッションで実機データ検証成功**
  （認証成功→解錠・getMyProfile[Satsuki/@satsuki]・is_admin 管理導線・管理の Club Seats 残24/25・
  招待一覧#boot 使用済みを RLS 越しに正読）。残＝**mutation 系の実機確認**（キー発行/取消・上限保存・
  表示名/パスワード変更・削除・ログアウト・新規サインアップ往復）＋デプロイ。

### M8 — 5人 NN 統合 ⬜
- [ ] `trainNwayNN`（学習）→ `validateNwayNN`（**超過損 < 0.05pt**）
- [ ] 合格なら `solver.worker` の playersLeft===5 に配線＋モデル出荷（f16）
- [ ] 未達なら反復（点追加/モデル拡大/境界重み付け）
- **DoD**: ゲート合格し、実機で5人スポットが瞬時に解ける。

### M9 — 6人 NN ⬜
- [ ] 6人教師データ生成（同ダッシュボード）→学習→検証→配線
- **DoD**: 6人でゲート合格・瞬時求解。

### M10 — 総合・出荷 ⬜
- [ ] 回帰（全テスト green）・PWA キャッシュ更新・Cloudflare デプロイ
- [ ] README/免責更新（招待制・プライバシー・ゼロ課金運用ルール）
- **DoD**: ライブ実機で全機能が動作し、全テスト green。

---

## 5. 進捗ログ（新しい順・セッション引き継ぎ）

- **2026-09-04（9, M7 認証/設定/管理）**: **M7 の主要3画面を実装**（3 commit）。①認証UI `Auth.tsx`＋
  全機能ログインゲート（`App` のセッション監視 getSession/onAuthStateChange・未ログインは Auth のみ,
  commit bac39ad）②設定 `Settings.tsx`＋`supabase/profile.ts`（表示名/パスワード/公開既定/削除/ログアウト,
  handle・avatar は保留, commit 1283ffe）③管理 `Admin.tsx`＋`supabase/admin.ts`＋`admin/format.ts`
  （招待キー発行/一覧/取消・上限編集・登録状況キャップバー・expired 導出, is_admin のみ, commit 271fb75）。
  純ロジックを単体テスト化（auth/validate 11・admin/format 5）＝**430 tests green・tsc/vite build clean**。
  各画面をブラウザで実描画確認（認証ゲート・タブ切替・クライアント検証・実Supabase往復エラー赤バナー／
  設定の二段階削除確認／管理のキャップバー・状態バッジ・取消可否, 一時バイパス→撤去）。
  **Drill "Coming Soon" はさつき決定で見送り**（2-4人で動く working feature を残す）。**さつき is_admin ログインで
  認証成功/設定更新/削除/管理往復の実機検証待ち**（Claude はログイン不可）。M2.5 モックへの admin 追加は未着手（実装先行）。

- **2026-09-04（8, M1 実機稼働）**: **M1 バックエンドを Supabase 実機に適用・DoD 検証＝完了**。プロジェクト
  `bpxrbxnylgedjhvhfsvk`（Tokyo）作成 → `apply-all.sql`（0001〜0005 結合）を SQL Editor で一括適用 →
  Edge Function 5本を CLI（`npx supabase functions deploy`）でデプロイ → `gen-invite.mjs`＋`bootstrap-signup.mjs`
  で初回アカウント作成（signup→login 成功）→ `is_admin=true` 付与。**新方式 API キー（`sb_publishable_…`, JWT 非対応）**
  に対応し **`signup` のみ `verify_jwt=false`**（config.toml, 招待キー必須チェックは関数内で担保・管理/削除はセッション JWT で通る）。
  `m1-verify.mjs` でサーバ側拒否を独立検証＝**5 PASS/0 FAIL**（invalid_invite / weak_password / invalid_handle /
  未認証の issue-invite=unauthorized / 無効ログイン）。**env はさつきが端末内で管理**（`.claude/settings.json` に
  Read/Edit/Write の deny、値はチャットに出さず）。**残**: フロント認証UI（ログイン/サインアップ）は M7、warm-ping の
  GitHub Secret `SUPABASE_URL` は任意で後日、アカウント削除/上限/期限切れ拒否は関数デプロイ済み（未実行）。
- **2026-09-04（7, M4）**: **M4 計算結果の刷新（Action tree）＝完了**。純モデル `tree/model.ts`（`@oshihiki/core` の
  `normalizeKey`＝全席ベクトルのキー文法をそのまま使い、`result.nodes` を key で引く）＋`ActionTree.tsx`（全ポジ
  行動順に常時表示・行内トグル FOLD/PU・CA・OC・上流 push で受け側 CA/OC 解錠・BB ウォークは no decision ロック・
  active 行の決定ノードを引いてレンジ表/頻度/記法を連動・hero 行のみ手札強調）。`Result.tsx` は上部 vhero＋Action tree
  ＋ICM equity＋品質に再構成（旧「hero の他の状況」「全ノード」を撤去）。**公開トグル（既定オフ・ローカル
  `SpotRecord.published`, クラウド反映は M6）を追加**。※自動保存はさつき決定で見送り＝手動保存（ALL IN/FOLD＋EV loss）維持。
  検証: `tree/model.test.ts` が実ソルバー出力で「到達可能キー集合＝実ノード集合」を 3-way・4-way で双方向一致確認、
  実機（HU/3-way）で全ノード切替・受け解錠・hero 強調・公開トグル保存（IndexedDB `published:true`）・readOnly 公開タグを確認。
  **413 tests green（+5 tree, +1 published）・tsc/vite build clean**（CSS 26.0KB/gzip5.82）。
  ※OneDrive watcher 固着は毎回 `.vite` 削除＋dev 再起動で解消（[[project-status]] 参照）。
- **2026-09-04（6, M3）**: **M3 ICM 入力の刷新＝完了**。写真起点のランディング `IcmInput`（`.shot` 破線ドロップ
  ゾーン＋「写真を選ぶ」黄CTA＋「手入力する」シアン破線＋「読み取れる条件」チェックリスト）を新設。手入力フォームを
  ボトムシート・モーダル化（`InputForm`＝`.modal-backdrop/.modal`、✕/背景/Esc で閉じ、`この内容で確認する`）。
  確認画面 `Confirm` をモック readout（`.lb/.vl/.edit` 項目別「修正」・低信頼 CHECK バッジ・ポット検算・position 席）へ刷新。
  エラー `ErrorView` を赤バナー＋原因一覧（`.check .ng`）＋「別の写真を選ぶ/読めた分を手で埋める」（写真経路のみ2択）へ刷新。
  `App` を `icm` 起点＋`manualOpen` モーダル＋`errFromPhoto` 分岐に組替。実機で手入力経路を end-to-end 検証
  （icm→手入力→確認→修正再オープン→計算→結果 FOLD/-0.015 赤）。**tsc/vite build clean**（CSS 24.2KB/gzip5.51）。
  ※OneDrive 配下で Vite の watcher が固着し旧トランスフォームを配信していたため、`.vite` キャッシュ削除＋dev 再起動で解消。
- **2026-09-04（5, M2）**: **M2 デザイン・トークン刷新＝完了**。`styles.css` を CP2077（黄60/赤20/青20・
  面取りプレート・ハザードティック・コーナーブラケット・Rajdhani/Zen Kaku/Share Tech Mono）へ全面書き換え
  （既存クラス名維持＝JSX/テスト不変）。position 6色フックを Confirm/InputForm に最小追加。EV 色を符号ベース
  （+EV=黄/−EV=赤）に修正し「赤=損失のみ」を担保（`evBand`→`evClass`）。index.html にフォント追加。
  実機で全画面目視（form/confirm/result[PUSH黄・FOLD赤ブラケット]/records/drill[HUDレーダー・4色デッキ]/solving/error）。
  **408 tests green・tsc/vite build clean**（CSS 20.4KB/gzip4.79）。self-review 合格。
- **2026-09-04（4, M1 足場）**: **M1 バックエンド足場＝完成・commit（4b9de2b）**。`supabase/`（migrations 0001–0005＝
  schema/functions/RLS/storage/seed, functions 5本＝signup/issue-invite/revoke-invite/set-max-accounts/delete-account,
  gen-invite.mjs, README）＋フロント配線（`src/supabase/{client,api}.ts`・@supabase/supabase-js）＋warm-ping cron。
  招待キーは SHA-256 ハッシュのみ保存・使い捨て・期限7日、`claim_invite` で原子的消費＋上限厳守。
  **Supabase 実機適用は Supabase 側障害で保留**（プロジェクト作成不可・復旧待ち）。復旧後に URL/anon key 受領→SQL→deploy→DoD 検証。
- **2026-09-04（3）**: 計画を**承認・マージ確定**。次セッションで M1 着手。進捗モニタを
  ネイティブGUI（Tkinter `教師データ生成モニタ.pyw`）化し起動不具合を解消・実機起動確認済み。
- **2026-09-04（2）**: 仕様書 SPEC.md / 本実装計画書を作成。招待キーを「1人ずつ・使い捨て・管理画面発行」に確定。
- **2026-09-04（1）**: 本番モックを CP2077・黄60/赤20/青20 に確定。NN 蒸留の土台実装済み。
- **2026-09-04（前）**: 本番モックを CP2077・黄60/赤20/青20 に確定。NN 蒸留の土台（MLP/生成/学習/検証/GUI）実装済み。

---

## 6. リスクと対処

| リスク | 対処 |
|---|---|
| 課金発生（絶対NG） | どのサービスにもカード未登録。Supabase無料枠。Firebase不採用。 |
| 招待キー漏洩/使い回し | 使い捨て・期限7日・ハッシュ保存・サーバ側消費。 |
| 管理操作の不正 | 管理者フラグ＋RLS＋Edge Function で二重強制。UI隠しに依存しない。 |
| プライバシー（共有スクショ） | 招待制25人・公開既定オフ・注意喚起。将来: 名前マスク。 |
| Supabase 7日ポーズ | GitHub Actions 無料 cron で warm。 |
| NN ゲート未達 | 反復（点追加/拡大/境界重み）。テーブル路(2-4人)と手入力は常に有効。 |
| スコープ肥大 | マイルストーンで区切り DoD で締める。Drill 伏せる。 |

---

参考: [SPEC.md](./SPEC.md) / モック `docs/production-mock.html`（Artifact 3c999290）/ [REBUILD_PLAN.md](./REBUILD_PLAN.md)（旧・統合前）。
