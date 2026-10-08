# ICM Local（ICM 読み取りだけのローカル版）

本体アプリから「スクショ読み取り → 条件確認 → 求解 → 結果 → 記録」だけを抜き出した版。
ログイン・サーバ同期・ホーム・Training・SIT & GO は無い。OCR も求解も端末内で完結し、
記録はその端末の IndexedDB にだけ残る。画面部品・OCR・ソルバーは本体とソースを共有している。

- エントリ: `packages/app/local/index.html` → `src/local/main.tsx` → `src/local/LocalApp.tsx`
- ビルド設定: `packages/app/vite.local.config.ts`（出力 `packages/app/dist-local/`）

## PC で使う

```bash
npm ci
npm run build:local --workspace @oshihiki/app
npm run preview:local --workspace @oshihiki/app   # http://localhost:4174
```

## iPhone で使う

iPhone は Service Worker（オフライン起動・ホーム画面アプリ化）に **HTTPS** が必要。
同じ Wi-Fi の PC から `http://192.168.x.x:4174` で開くこと自体はできるが、その場合は
オフライン起動・ホーム画面アプリ化が効かない（PC が起動している間だけ使える）。

常用するなら `dist-local/` を HTTPS の静的ホスティングに置く。サーバ処理は無いので
置くだけで動く。本体と同じ Cloudflare（Workers Builds）なら別プロジェクトとして:

| 項目 | 値 |
|------|-----|
| Build command | `npm run build:local --workspace @oshihiki/app` |
| 出力 | `packages/app/dist-local` |

一度 Safari で開いて「ホーム画面に追加」すれば、以後は電波が無くても起動・計算できる
（4人卓・5〜6人卓のテーブル（約11MB / 21MB）は、その人数を初めて解いたときに取得・キャッシュ）。
