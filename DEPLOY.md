# デプロイ手順（スマホで使えるようにする）

このアプリは**端末ローカル完結**（サーバー不要・すべてブラウザ内で計算）なので、
静的ファイルをどこかに置くだけで動きます。**リポジトリは非公開のまま**配信できる
**Cloudflare Pages**（無料）を推奨します。初回だけ下記の操作が必要です（数分）。

---

## Cloudflare（推奨・非公開のままでOK） ＝ 現在の配信先

**実際にこの方法で配信済み → https://pocket-icm.wsk641.workers.dev**

Cloudflare の Git 取り込みは「**Workers Builds**」フローに統合されている。静的アセット配信の
設定 `wrangler.jsonc`（リポジトリ直下・`assets.directory=packages/app/dist`・`main` 無し）は
コミット済みなので、ダッシュボードでは **Build command を入れて Deploy を押すだけ**。

1. https://dash.cloudflare.com/ にログイン（無料アカウントでOK）
2. **Workers & Pages** → **Create** → リポジトリ **`pocket-ICM`** を **Import**
   （初回のみ「Cloudflare の GitHub アプリ」に pocket-ICM へのアクセスを許可）
3. セットアップ画面で：

   | 項目 | 値 |
   |------|-----|
   | Project name | `pocket-icm` |
   | Build command | `npm run build --workspace @oshihiki/app` |
   | Deploy command | `npx wrangler deploy`（初期表示のまま） |
   | Protect with Cloudflare Access | OFF（ONだと閲覧にログインが要る） |

   Node は `.node-version`（=22）で固定済み。
4. **Deploy** → 1〜2分でビルド＆デプロイ。`https://pocket-icm.<サブドメイン>.workers.dev` が発行される。

以降は **`master` に push するたび自動で再デプロイ**される。
（ログに出る `workers_dev`／`preview_urls` の WARNING は「公開URLを自動有効化した」という通知で問題なし。）

### スマホにインストール（ホーム画面に追加）
- **iPhone（Safari）**: 発行URLを開く → 共有ボタン → **「ホーム画面に追加」**
- **Android（Chrome）**: 発行URLを開く → メニュー → **「アプリをインストール」/「ホーム画面に追加」**

アイコン（シアンのHUDレティクル）付きで、オフラインでも起動できます（PWA）。

---

## 代替: Vercel（こちらも非公開OK）

1. https://vercel.com/ に GitHub でログイン → **Add New… → Project**
2. `pocket-ICM` を **Import**（GitHub 認可は1回だけ）
3. 設定：
   - Framework Preset: **Vite**
   - Root Directory: （リポジトリ直下のまま）
   - Build Command: `npm run build --workspace @oshihiki/app`
   - Output Directory: `packages/app/dist`
4. **Deploy** → `https://pocket-icm.vercel.app`（のような URL）が発行されます。

※ Vercel の無料枠は非商用向けです。個人利用ならOK。

---

## メモ
- ルーティングは無し（単一ページ）なので SPA フォールバック設定は不要（`/api/slumbot/*` だけ Worker が受ける。下記）。
- `SharedArrayBuffer` 不使用のため COOP/COEP などの特別なヘッダーは不要。
- キャッシュ最適化は `packages/app/public/_headers`（Cloudflare 用）で設定済み。
- ローカルで本番相当を確認: `npm run build --workspace @oshihiki/app` → `npm run preview --workspace @oshihiki/app`

---

## Slumbot 中継（Training ▸ Slumbot HU）

このアプリは長らく **main を持たない assets-only Worker**（静的ファイルを置くだけ）で
配信していたが、Training タブの Slumbot 対戦だけは外部 API の中継が要るため、
中継用の Worker スクリプト `worker/index.ts` を 1 本だけ足している。

### なぜ中継が要るか
Slumbot の API（`https://slumbot.com/slumbot/api/*`）は POST 本体には
`Access-Control-Allow-Origin` を返すのに、**OPTIONS のプリフライトを Origin に関係なく
401 で拒否する**。`Content-Type: application/json` が必須なのでブラウザは必ず
プリフライトを飛ばす＝フロントから直接は叩けない。そこで同一オリジンで受けて
サーバ間通信に置き換える。

### 何が変わったか
- `wrangler.jsonc` に `main`（Worker スクリプト）と `assets.binding`（`ASSETS`）を追加
- `/api/slumbot/new_hand` と `/api/slumbot/act` だけを中継。それ以外のパスは
  これまでどおりビルド成果物をそのまま返す
- `login` は中継しない（パスワードを預からない方針）
- **ダッシュボード側の設定変更は不要**。Build command は
  `npm run build --workspace @oshihiki/app` のまま、Deploy command も
  `npx wrangler deploy` のままでよい

### 料金（カード未登録のまま無料枠で運用する）
静的アセットへのリクエストは Worker を起動しない（アセットが先に解決される）。
Worker が起動するのは `/api/slumbot/*` だけなので、無料枠の
**10 万リクエスト / 日**を消費するのは対局中のアクション送信だけ。
1 ハンド 3〜6 リクエストなので、25 人が毎日 100 ハンド打っても 1 万回 / 日程度で収まる。
無料プランは上限を超えても課金されず停止するだけなので、請求が発生することはない。

### ローカルでの確認
```
npm run build --workspace @oshihiki/app
npx wrangler dev --port 8788
curl -X POST http://127.0.0.1:8788/api/slumbot/new_hand -H "Content-Type: application/json" -d "{}"
```
開発サーバー（`npm run dev`）では Vite の `server.proxy` が同じ形で中継するので、
`wrangler dev` を立てなくても対局できる。

---

## SIT & GO（Durable Objects）

SIT & GO（`/api/sng/*`。会員同士の対人トーナメント。設計は `docs/SNG_DESIGN.md`）の審判役は
Cloudflare **Durable Objects**（`SngLobby` 1 インスタンス＋部屋ごとの `SngTable`）に持たせている。
ハンドの記録・試合結果は Worker（DO）が **Supabase に service role キーで書く**（アプリからは
直接書けない）。

### なぜ Durable Objects か

対人トーナメントは「今どういう状態か」を**1 箇所で確定させる審判**が要る（合法手の検証・
手番のタイムアウト・複数人が同時に操作したときの整合性）。Cloudflare KV や単純な API では
これができない。Durable Objects は「1 つの ID につき 1 インスタンス」が保証されるので、
部屋ごとに 1 つの `SngTable` を審判として使える。

### 無料枠の条件（カードを登録しない方針のまま使う）

- Durable Objects には「クラシック（KV ベース）」と「SQLite バックエンド」の 2 種類があり、
  **クラシックは Workers Paid プラン専用**。`wrangler.jsonc` の `migrations` で
  `new_sqlite_classes` を使っているのはこのため（`new_classes` だとクラシックになり弾かれる）。
- 無料枠（Workers Free、2026-09 時点）: リクエストは **10 万回 / 日**、WebSocket は
  「受信メッセージ 20 件につき課金上の 1 リクエスト」換算、SQLite ストレージは合計
  **13,000 GB-秒 / 日**。
- 超過すると **Error 1027** で新規リクエストが止まるだけで、無料プランのまま自動課金は
  されない（請求は発生しない）。

### シークレットの登録（さつきに依頼）

Worker には Supabase の URL/鍵を**すべてシークレットとして**登録する（`wrangler.jsonc` の
`vars` には何も置かない）。

1. Cloudflare ダッシュボード → **Workers & Pages** → `pocket-icm` → **Settings** →
   **Variables and Secrets** で、以下の 3 つを **Secret** として追加する:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`（Supabase ダッシュボード → **Project Settings** → **API** →
     `service_role` からコピー。絶対にフロントには渡さない）

   **型は必ず「Secret」**（「Text」だと平文で、しかも `keep_vars` を付ける前の自動デプロイで消えた）。
   追加後は画面の **Deploy**（または「Save and deploy」）を押して新しいバージョンに載せる。
   載っているかは手元で `npx wrangler secret list` を実行すると名前だけ一覧できる（値は出ない）。
   載っていない Worker は `/api/sng/*` が **503 `not_configured`** を返す（401 とは区別している）。
2. `supabase/migrations/0011_sng.sql` を Supabase の **SQL Editor** で 1 回実行する
   （`sng_games` / `sng_results` / `sng_hands` / `sng_hole_cards` を作る。冪等）。

### ローカルでの確認

```
cp .dev.vars.example .dev.vars   # 値を埋める
npm run build --workspace @oshihiki/app
npx wrangler dev --port 8788
```
Vite 側の `/api/sng` プロキシ設定は画面担当（A3a）の `vite.config.ts` を参照。

### 書き込み量の目安

1 ハンド ≈ 250B（`sng_hands`）＋ 参加人数 × 80B（`sng_hole_cards`）。1 日 10 試合 × 100
ハンドなら年 ≈ 270MB（Supabase 無料枠 500MB の半分程度）。`sng_games` / `sng_results` は
試合ごとに 1 回・数百バイトなので無視できる量。CPU 時間（10ms/req の無料枠上限）はショーダウン
評価が最大 6 人 × `eval7` で軽いはずだが、実測は A1 のエンジン実装後に `wrangler dev` で行い、
ここに追記する。

### ローカルの通し確認（実 Supabase・秘密なしで最後まで動かす）

**秘密は一切要らない。** 実 Supabase プロジェクトにも繋がない。手順:

1. `/auth/v1/user` と `/rest/v1/*` を受けるだけの小さな HTTP サーバーをポート **9911** で立てる
   （`/auth/v1/user` は適当な userId を返すだけ、`/rest/v1/*` は 200 を返すだけでよい。
   このモックサーバー自体はリポジトリに入れない・使い捨てでよい）。
2. `npx wrangler dev --port 8788 --var SUPABASE_URL:http://127.0.0.1:9911 --var SUPABASE_ANON_KEY:x --var SUPABASE_SERVICE_ROLE_KEY:x`
   で Worker を起動する（`vars` を CLI から渡しているだけなので `.dev.vars` も本物の鍵も不要）。
3. WebSocket で `{t:'auth', token}` → `{t:'act', ...}` を流すだけのスクリプトを書いて、複数人
   （2〜3 クライアント）が最後まで打てることと、DB 書き込みが `sng_hands`（ハンド数ぶん）／
   `sng_hole_cards`／`sng_games`／`sng_results` に届くこと（モックサーバー側でリクエストを
   ログすればわかる）を見る。

**確認済みの事実（2026-09-15 のローカル通し）**: 3 人卓 3 ハンド、2 人卓（片方が無操作）で
時間切れ→タイムバンク→自動処理→sitout、退室で残った 1 人の即勝利、作成者の重複作成が
409、再接続で手札復元、がいずれも動作した。
