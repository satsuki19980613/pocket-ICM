# Supabase バックエンド セットアップ手順（M1 / M8=βテスト仕上げ WP-A1）

Black Ops ICM のサーバ基盤（Auth / DB / RLS / 招待キー / 上限 / 管理 / 画像保存 / OCR データ基盤）。
**絶対条件: どのサービスにもクレジットカードを登録しない**（SPEC §7）。無料枠のみで運用する。

このディレクトリの中身:
- `migrations/0001〜0005_*.sql` … M1: スキーマ / 関数 / RLS / Storage / 初期データ
- `migrations/0006_beta.sql` … M8(βテスト仕上げ WP-A1): 非同期計算・画像保存・OCR データ基盤・通常投稿（SPEC v3）
- `functions/*` … Edge Function（signup / issue-invite / revoke-invite / set-max-accounts / delete-account / purge-images）
- `scripts/gen-invite.mjs` … 初回アカウント用ブートストラップ招待キー生成
- `scripts/m1-verify.mjs` / `scripts/m8-verify.mjs` … サーバ側の拒否・スキーマ存在の検証スクリプト

---

## 手順の全体像

1. Supabase 無料アカウント作成（カード無し）
2. プロジェクト作成（リージョン=Tokyo 推奨）
3. API 情報を取得 → `packages/app/.env.local` に記入
4. SQL を SQL Editor で適用（0001→0005）
5. Edge Function を CLI でデプロイ
6. ブートストラップ: 初回アカウント作成 → 自分に管理者フラグ付与
7. GitHub Actions の Secret（warm-ping 用）を設定
8. 動作確認（DoD）

---

## 1. アカウント作成（カード未登録を厳守）

1. https://supabase.com/ → **Start your project** → GitHub でサインイン（無料）。
2. 支払い方法は**登録しない**。Free プランのまま進む。

## 2. プロジェクト作成

1. **New project**。
2. Name: `pocket-icm`（任意）。
3. **Database Password**: 強いパスワードを生成し**手元に保管**（後で使う可能性）。
4. Region: **Northeast Asia (Tokyo)** 推奨。
5. Plan: **Free**。作成完了まで1〜2分待つ。

## 3. API 情報 → .env.local

1. 左メニュー **Project Settings → API**。
2. 次の2つをコピー:
   - **Project URL**（例 `https://abcdxyz.supabase.co`）
   - **Project API keys → `anon` `public`**（フロントに載せてよい公開キー）
3. `packages/app/.env.example` を `packages/app/.env.local` にコピーし、値を記入:
   ```
   VITE_SUPABASE_URL=https://abcdxyz.supabase.co
   VITE_SUPABASE_ANON_KEY=eyJhbGciOi...（anon public）
   ```
   ⚠️ **`service_role` キーは絶対にフロント/リポジトリに置かない**（Edge Function には自動注入される）。

## 4. SQL を適用

左メニュー **SQL Editor → New query** に、次の順で貼り付けて **Run**（1ファイルずつ）:

1. `migrations/0001_schema.sql`
2. `migrations/0002_functions.sql`
3. `migrations/0003_rls.sql`
4. `migrations/0004_storage.sql`
5. `migrations/0005_seed.sql`
6. `migrations/0006_beta.sql`（βテスト仕上げ。0001〜0005 適用済みの既存プロジェクトに追加で流す。
   `if not exists` / `add column if not exists` ベースで**何度実行しても壊れない**ので、
   最初から作る場合も 0001〜0005 の直後にそのまま続けて Run してよい）

エラーなく通れば、テーブル・RLS・Storage バケット・初期設定（上限25）が揃う。
0006 まで通すと、非同期計算用の列（`results.status` 等）・`images`/`ocr_reads` テーブル・
`spot-images`（private）バケット・通常投稿用の `threads` 拡張も揃う。

## 5. Edge Function をデプロイ（Supabase CLI）

Docker は不要（deploy はネイティブバンドル）。

1. CLI 導入（PowerShell）:
   ```
   npm install -g supabase
   ```
   （または `scoop install supabase` / `npx supabase ...`）
2. ログイン（ブラウザが開く。トークンは自分の手元だけで完結）:
   ```
   supabase login
   ```
3. プロジェクトにリンク（`<ref>` は Project URL のサブドメイン `abcdxyz`）:
   ```
   supabase link --project-ref <ref>
   ```
4. 6つの関数をデプロイ（リポジトリのルートで実行）:
   ```
   supabase functions deploy signup issue-invite revoke-invite set-max-accounts delete-account purge-images
   ```
   - `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` は Supabase 側で**自動注入**されるため、Secret 設定は不要。
   - JWT 検証は既定のまま（anon キーが JWT なので signup も通る／管理関数は本人セッションで通る）。
   - `purge-images` だけは追加で **`PURGE_TOKEN`** という関数用 Secret が要る（ユーザーセッションではなく
     GitHub Actions からの共有トークンで認可するため）。次のいずれかで設定:
     ```
     supabase secrets set PURGE_TOKEN=<十分にランダムな文字列>
     ```
     （または Dashboard の **Edge Functions → purge-images → Settings → Secrets**）。
     生成例（PowerShell）: `[Convert]::ToBase64String((1..32|%{Get-Random -Max 256}))`
     この値は次項の GitHub Secret `PURGE_TOKEN` と**同じ値**にすること。

## 6. ブートストラップ（初回アカウント＝管理者）

招待キーは管理者しか発行できないが、最初はまだ誰も居ない。以下で最初の1本を作る:

1. ローカルで生成（**生キーは自分だけが見る**）:
   ```
   node supabase/scripts/gen-invite.mjs
   ```
   → 生キー（例 `POCKET-AB3F-CD7K`）と、貼り付け用 SQL が表示される。
2. 表示された `insert into public.invite_codes ...` を **SQL Editor で Run**。
3. アプリを起動（`npm run dev --workspace @oshihiki/app`）→ サインアップ画面で
   表示名・ユーザー名（handle）・パスワード・**上記の生キー**を入力して作成。
4. 自分に管理者フラグを付与（SQL Editor、`<handle>` は自分のユーザー名）:
   ```sql
   update public.profiles set is_admin = true where handle = '<handle>';
   ```
   以後、アプリ内の管理画面（M7 で実装）から招待キーを発行できる。

## 7. GitHub Actions warm-ping の Secret

リポジトリ **Settings → Secrets and variables → Actions → New repository secret**:
- Name: `SUPABASE_URL` / Value: Project URL（`https://abcdxyz.supabase.co`）
- Name: `PURGE_TOKEN` / Value: 上記 5. で Edge Function に設定したのと**同じ値**
  （β仕上げで追加。未設定でも warm ping 自体は動く。`purge-images` 呼び出しだけスキップされログに出る）

`.github/workflows/warm-ping.yml` が週1で ping し、7日ポーズを防ぐ。同じジョブで
`purge-images`（画像の保持期限・総量上限に基づく削除。SPEC §7.2）も呼ぶ。

## 8. 動作確認（M1 の DoD）

以下がすべて通れば M1 完了:
- ✅ 招待キー発行（管理）→ そのキーでサインアップ → ログイン → アカウント削除
- ✅ 無効キー / 期限切れ / 定員超過（26人目）/ 非管理者の管理操作 が**サーバ側で拒否**される

（検証用の curl 例は本 README 末尾 or チャットで案内）

## 9. 動作確認（M8=βテスト仕上げ WP-A1 の DoD）

0006 を適用し、`purge-images` をデプロイしたら:

```
node supabase/scripts/m8-verify.mjs
```

を実行する（`packages/app/.env.local` の URL / anon キーのみ使用。ログイン不要）。
確認しているのは:
- `results` の新列・`images`/`ocr_reads` テーブル・`threads` の新列が存在する（0006 適用済み）。
- `images` / `ocr_reads` は未ログイン（anon）から行が見えない（RLS が効いている）。
- `threads` / `images` への未ログイン insert は拒否される（RLS が効いている）。
- `spot-images` バケットが存在する。
- `purge-images` がデプロイ済みで、誤った `PURGE_TOKEN` を拒否する。

**このスクリプトではカバーできない点**（ログインが要るため。WP-E の実機検証で確認する）:
- 本人ログイン状態での `images`/`ocr_reads` の実際の insert/select 可否。
- `spot-images` の署名 URL 経由の表示。
- `purge-images` を**正しい** `PURGE_TOKEN` で呼んだときの実削除挙動
  （実削除を試す場合は、期限切れ済みのテスト画像を用意した上で手動 curl 実行を推奨。
  本番データに影響するため自動テストには組み込んでいない）。

---

## セキュリティ設計メモ

- **招待キー**: DB は SHA-256 ハッシュのみ保存。生キーは発行時に一度だけ返す。使い捨て・期限7日。
  消費は `claim_invite`（advisory lock で全サインアップを直列化＝上限を超えない）で原子的。
- **管理操作**: `is_admin` フラグ ＋ RLS ＋ Edge Function 内の再検証で二重強制。UI 隠しには依存しない。
- **profiles.is_admin の自己昇格防止**: `protect_profile_privileged` トリガが authenticated ユーザーの
  is_admin 変更を無効化（service_role / SQL Editor からの初期付与は素通し）。
- **synthetic email**: Auth の識別子は `handle@users.pocket-icm.app`（メール送信なし）。
  パスワード忘れの復旧は将来 管理者リセット関数で対応（v2 スコープ外）。
