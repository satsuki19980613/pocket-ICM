# βテスト仕上げ 実装計画（BETA_PLAN / 2026-09-09）

対象仕様は [SPEC.md](./SPEC.md) v3。本書は**作業パッケージ（WP）・所有ファイル・受け入れ条件**を定める。
実装は Sonnet サブエージェントに分割して出し、**同時に同じファイルを触らせない**ことで衝突を防ぐ。

## 0. 全 WP 共通ルール

1. **自分の WP の所有ファイルだけを編集する**（他 WP のファイルは読むのは自由・書くのは禁止）。
2. 既存の設計・命名・コメント密度に合わせる。コメントは日本語。
3. 用語: 「押し引き」は使わない → **push / fold（AOF）**。
4. 完了時に必ず走らせる: `npm run typecheck` と `npm test`（root）。落ちたら直してから報告。
5. `git commit` はしない（統合はディレクターが行う）。
6. 不明点は憶測で決めず、**報告に「決めきれなかった点」として書く**。

---

## WP-A1 サーバ基盤（DB / RLS / Storage / 削除ジョブ）

**所有**: `supabase/migrations/0006_beta.sql`（新規）, `supabase/functions/purge-images/**`（新規）,
`supabase/README.md`, `.github/workflows/warm-ping.yml`

### やること

1. **`results` 拡張**（SPEC §9.2）: `status`(text, default `'done'`, check `solving|done|failed|aborted`),
   `client_id`(text), `hero_hand`, `hero_pos`, `players_left`(int), `verdict`(text check `ALL_IN|FOLD`, null 可),
   `hero_ev`(numeric), `solve_ms`(int), `error`(text), `image_id`(uuid → images, on delete set null),
   `ocr_read_id`(uuid → ocr_reads, on delete set null), `updated_at`(timestamptz default now())。
   - `solution` は null 可のまま（`status='solving'` の間は null）。
   - 一意制約 `unique (owner, client_id)`（冪等再送用。`client_id` null は重複可）。
   - インデックス: `(owner, created_at desc)` は既存。`(owner, status)` を追加。
2. **`images` 新設**: id uuid pk, owner uuid not null → profiles(cascade), kind text check(`spot`),
   bucket text not null default `'spot-images'`, path text not null unique, bytes int, width int, height int,
   mime text, sha256 text, created_at, `expires_at` timestamptz null, `protected` boolean not null default false。
   index: `(owner, created_at desc)`, `(expires_at) where expires_at is not null and not protected`。
3. **`ocr_reads` 新設**（SPEC §9.3・§12.2）: id, owner, image_id → images(on delete cascade),
   result_id → results(on delete set null), ok boolean not null, display_mode text, street text,
   issues jsonb not null default `'[]'`, issue_codes jsonb not null default `'[]'`,
   low_confidence jsonb not null default `'[]'`, raw_reads jsonb not null, state jsonb, final_state jsonb,
   corrections jsonb, app_version text, ocr_version text, device jsonb, created_at。
   index: `(ok, created_at desc)`, `(display_mode)`, `((device->>'aspect'))`。
4. **`threads` 拡張**: `kind` text not null default `'result'` check(`result|post`),
   `result_id` を **null 可**へ（`alter column ... drop not null`）, `body` text（≤2000 の check）,
   `image_url` text, `updated_at` timestamptz。
   check 制約 `threads_shape`: `(kind='result' and result_id is not null) or (kind='post' and (coalesce(body,'')<>'' or image_url is not null))`。
5. **RLS**:
   - `threads_insert` を書き換え: 通常投稿（`kind='post'`, `result_id is null`）を許可、
     結果投稿は従来どおり「自分が所有する result」に限定。
   - `threads_update`（新設）: 著者のみ（本文編集用）。
   - `images`: select = 本人 or `is_admin(auth.uid())`, insert = 本人, delete = 本人。
   - `ocr_reads`: select = 本人 or 管理者, insert = 本人, update = 本人（`final_state`/`corrections` の後追い書込み）。
6. **Storage `spot-images` バケット（private）**: `public=false`, 上限 1MB, mime は png/jpeg/webp。
   ポリシー: insert/update/delete = 自分の `<uid>/` 配下のみ、**select = 自分の配下 or 管理者**。
   （公開 URL は使わない。表示は署名 URL）
7. **Edge Function `purge-images`**（service_role・cron から呼ぶ）:
   - `expires_at < now() and not protected` の画像を Storage＋`images` から削除。
   - 画像総量が **700MB** を超える場合、`protected=false` の古い順に削除して 700MB 未満に戻す。
   - 保護画像だけで **300MB** を超えたら、削除はせず結果 JSON に `warn_protected_over` を立てて返す。
   - 認可: `Authorization: Bearer <PURGE_TOKEN>`（env）で保護。CORS は既存 `_shared/cors.ts` に合わせる。
   - 応答: `{ deleted, freedBytes, totalBytes, protectedBytes, warn_protected_over }`。
8. **cron**: `warm-ping.yml` に purge ステップを追加（同じ週1実行。`PURGE_TOKEN`/`SUPABASE_URL` secret 未設定なら
   スキップしてログのみ）。ワークフロー名は変えない。
9. `supabase/README.md` に **0006 の適用手順**（SQL Editor 貼り付け順）と Edge Function のデプロイ手順、
   必要な secret を追記。

### 受け入れ条件
- 0006 SQL が**既存データを壊さず**（すべて `if not exists` / `add column if not exists` / `drop policy if exists`）
  再実行可能（冪等）であること。
- 既存の `supabase/scripts/m1-verify.mjs` と同じ流儀で、`supabase/scripts/m8-verify.mjs` を追加し
  「新テーブル・新列・新ポリシーの存在」を確認できるようにする（実行はさつきが行う）。
- SQL はローカルで実行できないため、**構文の自己レビューを丁寧に**行うこと（PostgreSQL 15 想定）。

---

## WP-A2 OCR 出力の外出し（照合ビューのデータ源）

**所有**: `packages/ocr/src/readout.ts`（新規）, `packages/ocr/src/readout.test.ts`（新規）,
`packages/ocr/src/issueCodes.ts`（新規）, `packages/ocr/src/issueCodes.test.ts`（新規）,
`packages/ocr/src/pipeline.ts`, `packages/ocr/src/index.ts`,
`packages/app/src/ocr/prefill.ts`, `packages/app/src/ocr/prefill.test.ts`

### やること

1. **`readout.ts`**: 画像 × OCR 出力の照合に必要な値を、UI が直接描ける固定スキーマにまとめる。
   ```ts
   export interface ReadV<T> { readonly value: T; readonly conf: number }
   export interface OcrSeatReadout {
     readonly id: string;
     readonly pos?: string;          // 導出できた場合のみ（UTG/HJ/CO/BTN/SB/BB）
     readonly isHero: boolean;
     readonly isButton: boolean;
     readonly occupancy: ReadV<Occupancy>;
     readonly action: ReadV<SeatAction>;
     readonly stack: ReadV<number>;
     readonly bet: ReadV<number>;
     readonly low: string[];          // この席の低信頼キー（"stack" | "bet" | "action" | "occupancy"）
   }
   export interface OcrReadout {
     readonly street: ReadV<string>;
     readonly displayMode?: DisplayMode;
     readonly blinds: { readonly sb: ReadV<number>; readonly bb: ReadV<number> };
     readonly ante: { readonly scheme: AnteScheme; readonly amount: ReadV<number> };
     readonly blindChips?: { sb: number; bb: number; ante: number; level: number };
     readonly pot: ReadV<number>;
     readonly heroHand: ReadV<string>;
     readonly seats: readonly OcrSeatReadout[];   // 時計回り（RawReads.seats の順を保つ）
     readonly threshold: number;                   // 低信頼しきい値（既定 0.8）
     readonly lowConfidenceFields: string[];       // "UTG.stack" 等（pipeline の値と同一）
     readonly issues: string[];
     readonly issueCodes: string[];
     readonly chipCheck?: { applied: boolean; note?: string; correctedSeatId?: string };
   }
   export function buildReadout(reads: RawReads, extra?: {
     posById?: ReadonlyMap<string, string>;
     threshold?: number;
     issues?: readonly string[];
     lowConfidenceFields?: readonly string[];
     chipCheck?: ...;
   }): OcrReadout
   ```
   - **RawReads の値をそのまま写すだけ**（丸めや加工をしない）。UI 側の書式整形は UI の責務。
2. **`issueCodes.ts`**: issue メッセージ → 安定した理由コード（SPEC §12.2）。
   `street_not_preflop` / `street_unknown` / `display_mode_chips` / `out_of_scope_raise` /
   `out_of_scope_limp` / `out_of_scope_unclassified_bet` / `walk` / `seat_read_failed` /
   `checksum_mismatch` / `too_many_players` / `unknown`。
   既存のメッセージ生成箇所は**変更しない**（正規表現で分類する純関数を新設し、テストで固定する）。
3. **`pipeline.ts`**: `OcrValidation` に `readout: OcrReadout` を**必ず**含める（gate 失敗・復元失敗も含め全経路）。
   既存フィールドの意味・型は変えない（追加のみ）。
4. **`packages/app/src/ocr/prefill.ts`**: `OcrPrefillResult` に `readout?: OcrReadout` と
   `issueCodes?: string[]`、`imageSize?: {w:number;h:number}` を追加。
   - `displayMode !== 'bb'` の早期棄却でも `buildReadout` を返す（照合ビューを出すため）。
   - 既存4フィールド（`ok`/`form`/`issues`/`lowConfidenceFields`）の意味・型は**不変**（MAIN が依存）。
5. テスト: `readout.test.ts`（合成 RawReads → 期待どおりの席順・低信頼判定・pos 反映）、
   `issueCodes.test.ts`（既存の実メッセージ文字列を入力に、期待コードへ写る）、
   `prefill.test.ts` に「chips 表示でも readout が返る」ケースを追加。

### 受け入れ条件
- 既存 OCR テストが**すべて緑のまま**（回帰ゼロ）。
- `buildReadout` は RawReads を破壊しない純関数。

---

## WP-B1 UI: 照合モーダル ＋ 読み取れる条件の文言

**所有**: `packages/app/src/components/ImageModal.tsx`, `packages/app/src/components/Confirm.tsx`,
`packages/app/src/components/InputForm.tsx`, `packages/app/src/components/IcmInput.tsx`,
`packages/app/src/components/ErrorView.tsx`, `packages/app/src/styles.css`,
`packages/app/src/components/ocrReadoutView.ts`（新規・純関数＋テスト）

**前提**: WP-A2 の `OcrReadout` 型が入っていること。

### やること

1. **`ImageModal` を「元画像 × OCR 結果」モーダルへ拡張**（SPEC §5.2.3）。
   - props に `readout?: OcrReadout` を追加。無い場合は従来どおり画像だけ（後方互換）。
   - 見出し: 「元画像とOCR結果」。上段＝画像（既存のタップで原寸⇔全体を維持）、下段＝読み取り表。
   - 下段の中身:
     - ヘッダ行: ストリート / 表示モード（BB・チップ）/ SB・BB・アンティ（レベル番号があれば併記）/
       ポット / hero ハンド / 画像サイズ。
     - 席テーブル: ポジション（無ければ席ID）・hero/D バッジ・状態・アクション・スタック・ベット。
       各値の右に信頼度 `86%` を小さく添え、`conf < threshold` は CHECK 強調（既存 `.lowconf` の色に合わせる）。
     - `issues` があれば下に一覧（読めなかった理由）。
     - chipCheck が働いていればその旨と補正席。
   - スマホ幅（375px）で**横スクロールせずに**読めること。狭い場合は席テーブルを2行組みにしてよい。
2. **開ける場所を3つに**: `Confirm`（既存ボタン）/ `InputForm`（既存ボタン）/ `ErrorView`（新設ボタン）。
   - `ErrorView` に props `imageUrl?`, `readout?` を追加し、あるときだけ「🖼 元画像とOCR結果を見る」を出す。
3. **`ocrReadoutView.ts`（純関数・テスト付き）**: `OcrReadout` → 表示用の行データへ変換する
   （数値の桁揃え・`bet=0` の非表示・conf の % 化・CHECK 判定）。UI から算術を追い出し、Vitest で固定する。
4. **`IcmInput.READ_CONDITIONS` を SPEC §5.2.1 の表に一致させる**（6項目）。
   - 実装で本当に弾いているかを**コードで確認してから**書くこと（`streetGate` / `prefill.ts` の displayMode /
     `detectOutOfScope` / `MAX_PLAYERS`）。表と実装がずれていたら**ずれている事実を報告**する（勝手に実装を変えない）。
   - 補足注記（対応形式 PNG/JPEG/WebP・解析は端末内）をチェックリスト下に小さく置く。
   - `ErrorView` にも同じ `READ_CONDITIONS` を出す（「次はこの条件で撮ってください」）。

### 受け入れ条件
- `npm run typecheck` / `npm test` 緑。
- CSS は既存クラス命名（`.imgmodal*`, `.readout`, `.lowconf` など）に沿って追加し、既存の見た目を壊さない。
- CP2077 デザイン（黄60/赤20/青20）を守る。赤は「損失・エラー」だけに使う。

---

## WP-B2 サーバ同期のデータ層（UI 非依存）

**所有**: `packages/app/src/supabase/records.ts`（新規）, `packages/app/src/supabase/images.ts`（新規）,
`packages/app/src/supabase/ocrLog.ts`（新規）, `packages/app/src/supabase/solutionCodec.ts`（新規）,
上記の `*.test.ts`, `packages/app/src/records/model.ts`, `packages/app/src/records/model.test.ts`,
`packages/app/src/records/store.ts`

**前提**: WP-A1 のスキーマ定義（SQL は未適用でよい。列名を合わせる）。

### やること

1. **`records/model.ts` の `SpotRecord` を拡張**（後方互換に注意・既存の純関数は流用）:
   - `status: 'solving' | 'done' | 'failed' | 'aborted'`
   - `heroAction: HeroAction | null`（**任意になった**）
   - `evLoss: number | null`
   - `serverId?: string`（`results.id`）, `clientId: string`, `pendingSync?: boolean`, `error?: string`
   - `imageId?: string`, `ocrReadId?: string`
   - `result: SolveResultDto | null`（solving 中は null）
   - `aggregate()` は **done かつ heroAction != null** の記録だけを EV loss 集計に入れる。
     件数は `status='done'` の件数。テストを更新・追加。
   - `buildRecord` は「完了時に確定させる」用途と「開始時に作る」用途を分け、
     `startRecord(input)` / `finishRecord(rec, {result, ms})` を追加する（純関数）。
2. **`store.ts`（IndexedDB）**: `VERSION` を 2 に上げ、`clientId` インデックスを追加。
   既存レコード（v1・`heroAction` 必須・`status` 無し）を読み出すときは
   `status:'done'`, `clientId: id`, `pendingSync:false` を補って返す**マイグレーション**を入れる。
3. **`images.ts`**:
   - `compressForUpload(file: File): Promise<{ blob: Blob; width: number; height: number }>`
     … Canvas で長辺 1600px 以内・WebP q0.8。WebP 不可の環境は JPEG q0.85 にフォールバック。
   - `uploadSpotImage(blob, meta): Promise<FnResult<{ imageId: string; path: string }>>`
     … `spot-images/<uid>/<uuid>.webp` へ上げ、`images` 行を作る（`expires_at = now + 90日`,
     `protected=false`）。失敗画像用に `markImageProtected(imageId)` も用意（`expires_at=null, protected=true`）。
   - `signedSpotImageUrl(path, sec = 60)` … 署名 URL（private バケット）。
   - **アップロード失敗はアプリを止めない**（記録は続行し、`image_id` を null のままにする）。
4. **`ocrLog.ts`**: `logOcrRead(input): Promise<FnResult<{ id: string }>>`
   （owner・image_id・ok・display_mode・street・issues・issue_codes・low_confidence・raw_reads(=readout)・
   state・device{ua,dpr,w,h,aspect}・app_version・ocr_version）と
   `attachFinalState(ocrReadId, finalState, corrections)`。
   - `corrections` は「OCR が出した state」→「実際に計算に使った state」の差分を計算する**純関数**
     `diffStates(a, b)` を同ファイルに置きテストする（席ごとの stack/bet/action、人数、hero、ハンド、ブラインド）。
5. **`solutionCodec.ts`**: `SolveResultDto` の保存形。
   - `encodeSolution(dto)` / `decodeSolution(json)`。まず**素の JSON サイズを実測**するテストを書き、
     代表ケース（6人）で **60KB を超えるなら** `nodes[].hands` を 169bit マスクの base64 に畳む実装を有効化する
     （169 ハンドクラスの正準順は `handGrid.ts` を単一の真実として使う）。
   - 実測値（何 KB だったか・畳んだか否か）を**報告に必ず書く**。
6. **`records.ts`**（PostgREST 配線・`supabase/api.ts` の `FnResult` 流儀に合わせる）:
   ```ts
   createSolvingRecord(input: { clientId; spot; imageId?; ocrReadId?; heroHand; heroPos; playersLeft }): FnResult<{id}>
   completeRecord(id, { solution, ms, verdict, heroEv }): FnResult<{}>
   failRecord(id, message): FnResult<{}>
   abortStaleSolving(): FnResult<{ ids: string[] }>   // status='solving' を 'aborted' に落とす（起動時）
   setHeroAction(id, action: HeroAction | null, evLoss: number | null): FnResult<{}>
   listMyRecords(limit = 100): FnResult<SpotRecord[]>
   deleteMyRecord(id): FnResult<{}>
   ```
   - 行 → `SpotRecord` の写像は**純関数 `rowToRecord`** に切り出しテストする。

### 受け入れ条件
- Supabase を叩く関数は薄い配線に留め、**判断ロジックは純関数＋テスト**に置く。
- `npm run typecheck` / `npm test` 緑（`records/model.test.ts` の更新を含む）。
- UI ファイル（`App.tsx` / `components/**`）は**触らない**。

---

## WP-C 非同期計算・記録タブ・結果画面（公開レバー）

**所有**: `packages/app/src/App.tsx`, `packages/app/src/components/Result.tsx`,
`packages/app/src/components/RecordsView.tsx`, `packages/app/src/components/Toast.tsx`（新規）,
`packages/app/src/solveJob.ts`（新規・純ロジック＋テスト）, `packages/app/src/styles.css`

**前提**: WP-B2 完了（データ層）、WP-A1 の列名確定。

### やること

1. **`solveJob.ts`**: 計算ジョブの状態機械を純関数で定義（`idle → running → done|failed|aborted`）と、
   「計算中は新規入力を受け付けない」判定 `canStartSolve(state)`。テストを書く。
2. **`App.tsx`**:
   - `solving` 画面を廃止し、`solve()` を**非同期ジョブ化**（SPEC §5.7）。
     開始時: 画像があれば圧縮＋アップロード → `logOcrRead` → `createSolvingRecord` →
     **記録タブへ遷移**（`setScreen('history')`）→ Worker 起動。
   - 完了: `completeRecord` → ローカル更新 → **トースト**「計算が完了しました」（タップで結果画面）。
     失敗: `failRecord` → トースト「計算に失敗しました」（タップで記録タブ）。
   - 計算中は `IcmInput` を無効化（props `blocked` を渡し、文言を出す）。
     ※ `IcmInput.tsx` は WP-B1 所有のため、**props を増やす変更が必要なら報告に書き、実装はディレクターが調整する**。
     暫定として App 側で ICM タブ表示時に注意パネルを出す実装でよい。
   - 起動時に `abortStaleSolving()` を呼び、中断記録を落とす。
   - 記録一覧はサーバ（`listMyRecords`）を正とし、ローカルキャッシュを先に描いて差し替える。
3. **`Result.tsx`**:
   - 「記録する」ボタンと保存フェーズ UI を**廃止**。
   - 「この局面での自分の選択」は **ALL IN / FOLD / 未選択** の3択にし、押した時点で保存（`setHeroAction`）。
   - **公開レバー**（トグル1本）: オンで公開（コメント欄＋公開実行）、オフで公開取り消し。
     状態はサーバの `is_public` を正とする。処理中・失敗の表示を持つ。
   - 読み取り専用（記録・スレッド由来）の表示は現行を維持。
4. **`RecordsView.tsx`**: 状態行（計算中スピナー / 完了 / 失敗＋再計算 / 未選択タグ / 公開タグ）、
   集計の定義変更（SPEC §5.4）、削除の確認。
5. **`Toast.tsx`**: 画面下（タブバーの上）に出る CP2077 調のトースト。`role="status"`、
   自動で 5 秒後に消える、タップでコールバック、×で即閉じ。同時に1つ。

### 受け入れ条件
- 計算中にホーム/スレッド/設定へ移動しても計算が続き、完了時にトーストが出る（ブラウザ実機で確認）。
- 計算中に ICM タブから新しい画像を選べない。
- `npm run typecheck` / `npm test` 緑。

---

## WP-D スレッドの通常投稿（文字のみ / 文字＋画像）

**所有**: `packages/app/src/supabase/feed.ts`, `packages/app/src/supabase/feed.test.ts`,
`packages/app/src/components/Home.tsx`, `packages/app/src/components/Thread.tsx`,
`packages/app/src/components/PostComposer.tsx`（新規）, `packages/app/src/App.tsx`, `styles.css`

**前提**: WP-A1（threads 拡張）・WP-C 完了（App.tsx の競合回避のため C の後に着手）。

### やること

1. **`feed.ts`**:
   - `FeedPost` / `ThreadDetail` に `kind: 'result' | 'post'`, `body: string | null`,
     `image_url: string | null`, `updated_at` を追加。`result` は **null 可**に（型変更）。
   - `THREAD_SELECT` の `results!inner` を **左結合**（`!inner` を外す）に変更し、通常投稿も拾えるようにする。
   - `createPost({ body, imageFile }): FnResult<{ thread_id }>` … 画像は既存 `uploadThreadImage` を使い、
     `threads` に `kind='post'` で挿入。本文・画像とも空なら拒否。
   - `editPost(threadId, body)` / `deletePost(threadId)`（著者のみ・RLS で二重に担保）。
   - `mapFeedRow` を通常投稿に対応させ、**純関数のテストを追加**（結果投稿・通常投稿の両方）。
2. **`Home.tsx`**: 通常投稿カード（本文＋画像＋返信数＋♡）を追加。結果投稿は現行のまま。
   空状態の文言を更新（「投稿するか、計算結果を公開するとここに並びます」）。
3. **`Thread.tsx`**: 見出しを種別で切り替え（結果＝ResultCard / 通常＝本文＋画像）。
   自分の通常投稿は本文編集・削除ができる。返信まわりは現行のまま。
4. **`PostComposer.tsx`**: モーダル。本文（2000字・カウンタ）＋画像1枚（プレビュー・外す）＋送信。
   `IcmInput` と同じ file input の作法（`accept="image/png,image/jpeg,image/webp"`）。
5. **`App.tsx`**: ホームの FAB を**投稿コンポーザ**に付け替える（計算は ICM タブから）。
   投稿成功でフィード再取得＋トースト「投稿しました」。

### 受け入れ条件
- 結果投稿・通常投稿が同じフィードに時系列で混ざって並ぶ。
- 通常投稿のスレッドでも返信・♡・編集・削除ができる。
- `npm run typecheck` / `npm test` 緑。

---

## WP-E 実機検証（AI がユーザーと同じ経路で操作）

**担当**: ディレクター（このセッション）。**さつきの操作はログインのみ**。

1. ローカル dev（5173・本番 Supabase）を起動 → さつきがログイン。
2. AI が実施:
   - **スレッド**: 通常投稿（文字のみ）→ 画像付き投稿 → スレッドを開く → 返信（文字）→
     返信（文字＋画像）→ 自分のコメント編集 → ♡ → 本文編集 → 削除 → フィード反映確認。
   - **OCR 照合モーダル**: スクショ投入 → 条件確認から「元画像とOCR結果」→ 値と画像の突き合わせ →
     修正モーダルからも同じ内容が出るか → エラー画像でも出るか。
   - **非同期計算**: 計算開始 → 記録タブに「計算中」→ 他タブ操作 → 完了トースト → 結果へ →
     自分の選択（任意）→ 公開レバー ON/OFF。
   - **後片付け**: テスト投稿・テスト記録を削除。
3. 結果を本書の末尾「検証ログ」に追記する。

---

## 進行順（依存関係）

```
A1（DB）     ┐
A2（OCR）    ┘→ B1（照合UI）        ┐
              → B2（データ層）      ┘→ C（非同期・記録・結果）→ D（通常投稿）→ E（実機検証）
```

- A1 / A2 は同時に走らせる（ファイル完全分離）。
- B1 / B2 は同時に走らせる（UI と非 UI で分離）。
- C・D は `App.tsx` / `styles.css` を触るため**直列**。

---

## 検証ログ（WP-E / 2026-09-09・ローカル dev 5173 × 本番 Supabase・375×812）

ログインのみさつき。以降の操作はすべて AI が実施。テストデータは検証後に AI が削除済み
（残っているのは検証前からある実データ1件と、OCR 失敗サンプル1枚＝下記 5）。

### 通ったもの
| 検証項目 | 結果 |
|---|---|
| 通常投稿（文字のみ） | 投稿→フィード先頭に反映・トースト「投稿しました」 |
| 通常投稿（文字＋画像） | Storage へアップロード・フィードに画像表示 |
| スレッド返信（文字 / 文字＋画像） | 両方成功・返信数が増える |
| 自分のコメント編集 | 「（編集済み）」付きで反映 |
| ♡ ON/OFF | 1↔0 が往復 |
| 通常投稿の本文編集・削除 | 反映・削除でフィードから消える |
| 結果投稿と通常投稿の混在表示 | 時系列で正しく混在 |
| 読み取れる条件（6項目） | 実装と一致した文言が `icm` と `error` の両方に表示 |
| OCR 照合モーダル | 確認画面・修正モーダル・エラー画面の3か所から同一内容で開く |
| OCR 出力の正しさ | 正解ラベル（`EC7CD106`）と hero/ハンド/ブラインド/ポット/全席スタックが一致 |
| 非同期計算 | 記録タブに「計算中」→他タブ操作可→完了トースト（求解 5.38s） |
| 計算中の入力抑止 | ICM タブの「写真を選ぶ」「手入力する」が無効＋注意文言 |
| 中断→再計算 | リロードで `aborted` に落ち「再計算」導線が出る |
| 自分の選択（任意） | 未選択のまま記録が残り、後から選ぶと EV loss 表示 |
| 公開レバー ON/OFF | 公開でフィードに結果カード＋コメント、OFF で取り消し（記録は残る） |
| 画像の圧縮 | 1.7MB → **0.11MB**（目標 300KB を大きく下回る） |
| エラー画像のDB登録 | チップ表示のスクショが `protected` で保存され、管理画面に「失敗 1件 / display_mode_chips」 |
| 管理画面の運用ビュー | ストレージ使用量・失敗内訳が実データで表示 |
| 記録の削除 | サーバ・ローカル・画像が消える |

### 検証で見つけて直したもの
1. **`solve_ms` が小数のまま送られ、完了更新が 400 で失敗**（記録がサーバ上で「計算中」のまま残る）
   → `Math.round` して送るよう修正。**この検証をしなければ β で全員が踏んでいた**。
2. **起動時の中断掃除が、ローカルで完了済み・サーバ未反映の記録を「中断」で塗り潰す**
   → 再送を先に実行する順序へ変更＋一覧のマージでローカルの `done` を優先。
3. 照合モーダルのアンティが `0.25757575757575757bb` と出る → `formatAmount`（小数2桁）を追加・テスト追加。
4. ボタン文言が「元画像を確認」のままで中身（OCR結果）が伝わらない → readout があるときは「元画像とOCR結果」。
5. 設定の古い注記「※ 公開設定はホーム（スレッド）実装後に反映されます。」を削除。
6. 設定「計算したら最初から公開する」が**どこからも読まれていなかった** → 結果画面の公開レバーの初期値に配線。

### 検証で見つけて直したもの（OCR 精度側・同日修正済み）
7. **iOS/BB フレームの action 58.3% / bet 75%** → **両方 100%**（Android 20 フレームは数値完全一致＝回帰ゼロ）。
   - 原因: fold 判定はアクションタグの文字認識ではなく**カード裏の青画素比**（`cardState.isActiveHand`）で
     行っており、固定座標経路は機種プロファイルから指標（bright/strong）を渡すのに、**本番のアンカー抽出
     経路は誰も渡しておらず常に Android 既定**だった。iOS はカード裏が沈んだ紫で bright が常に 0 のため、
     生きている席が軒並み fold と判定されていた。
   - bet の誤りはその派生（`action==='fold'` の席はベットを読み飛ばす実装）。fold を直すと bet も直った。
   - 対処: 機種フラグを持たず、**フレーム内の全席の青画素比から指標を自動選択**する
     （`cardState.pickHandActiveRule`）。Android 系と判れば従来どおり bright/0.06（回帰ゼロ）、
     そうでなければ strong/0.15。
   - **既知の限界**: 「非 hero の生存席が1つも無い Android フレーム」では判別材料が無く iOS 系と誤判定しうる。
     ただしそれは有効な AOF 決定局面ではない（ウォーク＝下流で棄却）ため実害は無い想定。
     iOS のフィクスチャが 2 枚しかないのが本質的な弱点で、実利用の失敗画像が溜まったら
     `pullFailures.ts` で回収して再較正する（§12.3）。

### 未解決
- Android（チップ表示）側の stack 75.6% / bet 88.9% / pot 75.0%。今回の fold 判定とは別要因
  （BB 読み取り・pot 読み取りの既存課題）で、今回の変更前後で数値は完全に同一。
- 検証で作った OCR 失敗サンプル（チップ表示・保護画像）1枚が `images` に残っている。実害はないが、
  失敗統計から外したい場合は Supabase 側で当該行を削除する。
