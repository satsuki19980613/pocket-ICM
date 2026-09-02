# デプロイ手順（スマホで使えるようにする）

このアプリは**端末ローカル完結**（サーバー不要・すべてブラウザ内で計算）なので、
静的ファイルをどこかに置くだけで動きます。**リポジトリは非公開のまま**配信できる
**Cloudflare Pages**（無料）を推奨します。初回だけ下記の操作が必要です（数分）。

---

## Cloudflare Pages（推奨・非公開のままでOK）

1. https://dash.cloudflare.com/ にログイン（無料アカウントでOK）
2. 左メニュー **Workers & Pages** → **Create** → **Pages** タブ → **Connect to Git**
3. **GitHub を認可**し、リポジトリ **`pocket-ICM`** を選ぶ
   （「Cloudflare の GitHub アプリ」に pocket-ICM へのアクセスを許可する。これが1回だけの認可です）
4. ビルド設定を次のとおり入力：

   | 項目 | 値 |
   |------|-----|
   | Production branch | `master` |
   | Framework preset | `None`（または Vite） |
   | Build command | `npm run build --workspace @oshihiki/app` |
   | Build output directory | `packages/app/dist` |
   | Root directory | （空欄のまま＝リポジトリ直下） |

5. **Environment variables** に1つ追加（Node のバージョン固定）：
   - `NODE_VERSION` = `22`
6. **Save and Deploy** → 1〜2分でビルド完了。`https://pocket-icm.pages.dev`（のような URL）が発行されます。

以降は **`master` に push するたび自動で再デプロイ**されます。

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
- ルーティングは無し（単一ページ）なので SPA フォールバック設定は不要。
- `SharedArrayBuffer` 不使用のため COOP/COEP などの特別なヘッダーは不要。
- キャッシュ最適化は `packages/app/public/_headers`（Cloudflare 用）で設定済み。
- ローカルで本番相当を確認: `npm run build --workspace @oshihiki/app` → `npm run preview --workspace @oshihiki/app`
