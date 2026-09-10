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
