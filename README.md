# Black Ops ICM

[![CI](https://github.com/satsuki19980613/pocket-ICM/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/satsuki19980613/pocket-ICM/actions/workflows/ci.yml)
[![Live](https://github.com/satsuki19980613/pocket-ICM/actions/workflows/live.yml/badge.svg?branch=master)](https://github.com/satsuki19980613/pocket-ICM/actions/workflows/live.yml)
[![CodeQL](https://github.com/satsuki19980613/pocket-ICM/actions/workflows/codeql.yml/badge.svg?branch=master)](https://github.com/satsuki19980613/pocket-ICM/actions/workflows/codeql.yml)

ポーカーチェイス クラブマッチ（6 人 SNG・固定ペイアウト +5/+3/+2/+1/0/−1pt）向けの **push/fold ICM 復習ツール**。招待キーを持つクラブのメンバーだけが使える Web アプリ（PWA）。

サイト：https://pocket-icm.wsk641.workers.dev/

- **ICM** — スクショか手入力で盤面を入れると、Nash 均衡の push/fold と EV 差を出す。計算は端末の中で行う。
- **Home** — 計算結果の公開、スレッド・コメント・♡、Slumbot のランキング。
- **Training** — Slumbot とのヘッズアップ、メンバー同士の SIT & GO、AOF ドリル、成績とハンド履歴。
- **記録・設定** — 自分の計算の記録、表示名・アイコン、アカウントの削除。

**リアルタイムアシスタンス（RTA）は実装しない。** プレイ中の支援は一切提供しない。

## 安全とプライバシー

### ひと目で

- **招待キーが無いと、会員になれません。** 会員でない人は、データを何も読めません。
- **メールアドレスと本名は求めません。** ログインはユーザー名とパスワードだけです。
- **スクショ・非公開の計算結果・自分の手札は、ほかの会員に見えません。**
- **SIT & GO で、ほかの人の手札と山札は見えません**（ショーダウンで公開された札を除く）。
- **課金・広告・アクセス解析はありません。** このサイト以外のスクリプトは動かない設定です。
- **ここに書いたことの一部は、自動の確認で確かめ続けています。** 結果は誰でも見られます（上のバッジ）。

一方で、**運営者（管理者と、サーバーの持ち主）は、サーバーに置いた情報をすべて見ることができます。** 非公開の計算結果やスクショも、不具合や読み取りの間違いを調べるために確認することがあります。運営者を信頼できるクラブの中で使うアプリです。

以下は、その詳しい中身と根拠です。

### 扱う情報の一覧

| 情報 | サーバーに保存されるもの | 運営者が見られるか | ほかの会員に見えるか |
|---|---|---|---|
| メールアドレス・本名 | **求めない・保存しない**（ログイン用に、実在しない宛先 `<ユーザー名>@users.pocket-icm.app` を中で作る） | — | — |
| パスワード | Supabase の認証の仕組みがハッシュで保存する | 元のパスワードは見られない | 見えない |
| ユーザー名・表示名・アイコン画像・枠の色・バッジ | 保存する | 見られる | 見える |
| IP アドレス・ブラウザの種類 | アプリは保存しない。ただし Supabase の認証の仕組みが、ログインの記録として残す（Supabase の標準の動作） | 見られる | 見えない |
| 計算した局面と結果 | 保存する（自分で消せる） | 見られる | **公開を選んだものだけ** |
| スクショ | 端末で縮小した版（長辺 1600px）だけを保存する。原本は送らない。**90 日で消える** | 見られる | 見えない |
| 読み取れなかったスクショ | 読み取りの改善のため、**期限なしで残る**（記録を消しても残る。アカウントを消すと消える） | 見られる | 見えない |
| スクショの読み取り記録（読んだ値・直した値・端末の種類と画面の大きさ） | 保存する | 見られる | 見えない |
| スレッド・コメント・♡・スレッドの画像 | 保存する（自分で消せる） | 見られる | 見える |
| Slumbot の成績（ハンド数と収支の合計） | 保存する | 見られる | 見える（ランキング） |
| Slumbot のハンド履歴 | 保存する | 見られる | 見えない |
| SIT & GO の進行中の卓（山札・全員の手札を含む） | Cloudflare に保存する（**終わった卓も残る**） | 見られる | 自分の手札と、公開された札だけ |
| SIT & GO の記録（試合・ハンド・順位） | 保存する | 見られる | 同じ試合の参加者に見える（ほかの人の手札は、公開されたものだけ） |
| SIT & GO の自分の手札の記録 | 保存する | 見られる | 見えない |
| アプリのエラーの記録（エラーの内容・画面・端末の種類） | 保存する（**90 日で消える**） | 見られる | 見えない（送った本人も読めない） |
| 設定・Slumbot のトークン | **保存しない**（自分の端末にだけ置く） | 見られない | 見えない |

外部のサービスに届くもの：

- **Supabase** — ログイン・データベース・画像の保存。通信を受けるので、接続の情報（IP アドレスなど）が届く。
- **Cloudflare** — サイトの配信と、Slumbot の中継・SIT & GO のサーバー。接続の情報が届く。
- **Google Fonts** — 文字（フォント）を読むとき。サイトを開くと Google に接続の情報が届く。
- **Slumbot**（slumbot.com） — Slumbot と打つとき。このサイトのサーバーが中継し、届くのは Slumbot のトークンと打った手だけ（ログインのパスワードは中継しない）。

### 期待できること・できないこと

期待できること：

- 招待キーを持たない人は会員になれない（キーは 1 回限り・期限つきで、会員数にも上限がある）。
- 会員でない人やログインしていない人に、データを読まれない。
- ほかの会員に、スクショ・非公開の計算結果・読み取り記録・Slumbot の履歴・自分の手札を見られない。
- SIT & GO で、ほかの参加者に手札と山札を見られない。札の並びを予測されない。
- アカウントを消すと、画像のファイルと記録がまとめて消える。
- 運営者に、メールアドレスと本名を知られない。

期待できないこと（限界）：

- **運営者はサーバーに置いた情報をすべて見られる。** 非公開の計算結果・スクショ・読み取り記録・SIT & GO の山札と全員の手札を含む。
- **表示名・アイコン・投稿・公開した結果・Slumbot の成績は、会員全員に見える。**
- **読み取れなかったスクショは、アカウントを消すまで残る。**
- **SIT & GO の終わった卓（山札と全員の手札）は Cloudflare に残る。** 消す処理はまだ無い。
- **SIT & GO の部屋を作った人がアカウントを消すと、その試合の記録はほかの参加者の分も消える。**
- **Slumbot のランキングの値は、端末が送る値をそのまま数える。** 1 ハンドあたり ±200bb を超える値は断るが、それ以内のごまかしは防げない。
- **SIT & GO のサーバーには、リクエストの回数の制限が無い。** 1 人が持てる部屋は 1 つまで。
- **会員が画像を上げ続けて保存容量を埋めることは、防ぎきれない。** 古い画像を毎週消して和らげている。
- **外部のサービス（Supabase・Cloudflare・Google・Slumbot）がどう扱うかは、それぞれの規約による。**
- **第三者による監査は受けていない。** 個人で運営していて、確かめているのは下の自動の確認とテストだけ。

### 仕組みと根拠

想定している相手は、ほかの会員の記録や手札を覗こうとする会員、入り込もうとする会員でない人、そして Web の一般的な攻撃です。ブラウザは信用しません。誰が何を読めるかはデータベースが決め、SIT & GO のルールの判定と札を配るのはサーバーが行います。

| 守ること | 仕組み | 根拠 |
|---|---|---|
| 招待された人だけが会員になる | 登録はサーバーの関数だけが行い、招待キーを確かめてから作る。キーはハッシュで保存し、1 回使うと無効になる | [signup/index.ts](supabase/functions/signup/index.ts)・[0001_schema.sql](supabase/migrations/0001_schema.sql)・[0008_security.sql](supabase/migrations/0008_security.sql)（`register_member`） |
| 会員でない人に何も読ませない・他人の記録を読ませない | すべての表で行ごとの読み書きの規則（RLS）を使う。読めるのは会員だけで、非公開のものは本人だけ | [0008_security.sql](supabase/migrations/0008_security.sql)・[0010_hu_hands.sql](supabase/migrations/0010_hu_hands.sql)・[0011_sng.sql](supabase/migrations/0011_sng.sql)。外から確かめる [scripts/live-check.mjs](scripts/live-check.mjs) |
| 画像を他人に見せない | 画像の置き場はすべて非公開。会員には 1 時間で切れる署名つきの URL だけを渡す。データベースに入る画像の参照は「このアプリの、本人のフォルダ」の形に限る | [0008_security.sql](supabase/migrations/0008_security.sql)・[storageUrls.ts](packages/app/src/supabase/storageUrls.ts)（テストつき） |
| ログインした本人だけが操作できる | 管理者の印とユーザー名は本人にも書き換えられない。SIT & GO のサーバーは、つなぐたびにログインを Supabase に確かめ、5 秒以内に名乗らない接続は切る | [0008_security.sql](supabase/migrations/0008_security.sql)・[worker/sng/auth.ts](worker/sng/auth.ts)・[worker/sng/wsAuth.ts](worker/sng/wsAuth.ts) |
| 手札と山札を見せない | ブラウザに送る卓の情報から山札と手札を除き、手札は本人の接続にだけ送る。記録でも、手札は本人だけが読める表に分ける | [view.ts](packages/sng/src/engine/view.ts)・[worker/sng/table.ts](worker/sng/table.ts)・テスト [table.test.ts](packages/sng/src/engine/table.test.ts) |
| 札の並びを予測されない | シャッフルと部屋の番号に、予測できない乱数（`crypto.getRandomValues`）を使う | [worker/sng/table.ts](worker/sng/table.ts)・[cards.ts](packages/sng/src/engine/cards.ts)・[worker/sng/router.ts](worker/sng/router.ts) |
| 中継を悪用させない | Slumbot の中継は打つための 2 つの操作だけを通し、大きさと待ち時間に上限を置く | [worker/index.ts](worker/index.ts) |
| ほかの人の名前や投稿で画面を乗っ取られない | 画面は React が文字として表示する。さらに、このサイト以外のスクリプトは動かない設定にしている | [packages/app/public/_headers](packages/app/public/_headers) |
| 画像を溜め込まない | 期限の切れた画像と、容量を使いすぎた人の古い画像を毎週消す | [purge-images/index.ts](supabase/functions/purge-images/index.ts)・[purgePlan.ts](supabase/functions/_shared/purgePlan.ts)・[warm-ping.yml](.github/workflows/warm-ping.yml) |
| アカウントを消したら残さない | 画像のファイルを先に消し、消せたときだけアカウントと記録を消す | [delete-account/index.ts](supabase/functions/delete-account/index.ts)・[userFiles.ts](supabase/functions/_shared/userFiles.ts)（テストつき） |
| 鍵やパスワードを漏らさない | リポジトリには置かず、Cloudflare・Supabase・GitHub の秘密の設定に置く | [DEPLOY.md](DEPLOY.md)・[.dev.vars.example](.dev.vars.example) |

運用の手順（本番への反映・ダッシュボードの設定・確かめ方）は [docs/SECURITY.md](docs/SECURITY.md) にあります。

### 自動の確認

このページの上のバッジは、次の確認に通っていることを示します（安全を保証するものではありません）。

| 確認 | 何を確かめているか | いつ |
|---|---|---|
| [CI](https://github.com/satsuki19980613/pocket-ICM/actions/workflows/ci.yml) | 型チェックとテスト（手札を見せないこと・画像の参照の検証・アカウント削除の手順を含む） | コードを変えるたび |
| [Live](https://github.com/satsuki19980613/pocket-ICM/actions/workflows/live.yml) | 本番のサイトが届くか、保護ヘッダがリポジトリの設定どおりか、Worker が余計なものを通さないか、ログインしていない人に Supabase が表・画像の一覧・管理用の関数を何も返さないか、下の Observatory の評価 | 毎週と、配信やサーバーを変えたとき |
| [CodeQL](https://github.com/satsuki19980613/pocket-ICM/actions/workflows/codeql.yml) | GitHub 公式のコードスキャン（危ない書き方が無いか） | コードを変えるたびと毎週 |
| [Mozilla HTTP Observatory](https://developer.mozilla.org/en-US/observatory/analyze?host=pocket-icm.wsk641.workers.dev) | 公開しているサイトの保護ヘッダ。**A+**（125 点、12 項目すべて合格。2026-10-11 に Live で測定）。A+ を下回ると Live が失敗する | Live が毎週測る。リンク先でいつでも測り直せる |

### 問題を見つけたら

[SECURITY.md](SECURITY.md) を見てください。このリポジトリの Security タブから、公開されない形で運営者に知らせることができます。

### この節の書き方について

読む人が確かめやすいよう、次の考え方に沿って書いています。

- **大事なことを先に短く、詳しいことは後ろに**（英国の個人情報保護機関 ICO の「[段階的に示す](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/the-right-to-be-informed/what-methods-can-we-use-to-provide-privacy-information/)」考え方）
- **扱う情報を決まった形の表にする**（カーネギーメロン大学の[プライバシーの「栄養成分表示」の研究](https://doi.org/10.1145/1753326.1753561)。Apple や Google のアプリストアの表示も同じ考え方）
- **期待できること・できないことを両方書き、想定する相手と対策の根拠を示す**（[OpenSSF Best Practices](https://www.bestpractices.dev/en/criteria/1) の基準）
- **知らせ方を用意し、動かしている検査を示す**（[GitHub のリポジトリのベストプラクティス](https://docs.github.com/en/repositories/creating-and-managing-repositories/best-practices-for-repositories)）

## 開発

npm workspaces のモノレポ（TypeScript）。

```
packages/
  core/     データ契約（169 ハンドクラス・ポジション・盤面と解のスキーマ）
  solver/   MH-ICM・ハンド評価・equity テーブル・push/fold Nash（HU〜6 人）
  harness/  HRC 照合ハーネス
  ocr/      スクショの読み取り
  sng/      SIT & GO のルール（サーバーとブラウザで共有）
  app/      PWA（React + Vite）。ソルバーは Web Worker で端末内実行
worker/     Cloudflare Worker（Slumbot の中継・SIT & GO の Durable Objects）
supabase/   マイグレーション・Edge Functions
```

```bash
npm install
npm test                                  # 全パッケージのテスト（Vitest）
npm run typecheck                         # 型チェック
npm run dev   --workspace @oshihiki/app   # App を Vite dev で起動（:5173）
npm run build --workspace @oshihiki/app   # App を本番ビルド（PWA 生成）
node scripts/live-check.mjs               # 本番を外から確かめる（Live と同じ）
```

- 仕様：[SPEC.md](SPEC.md) / 進め方：[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)
- デプロイ（Cloudflare Workers Builds・Supabase）：[DEPLOY.md](DEPLOY.md)・[supabase/README.md](supabase/README.md)
- SIT & GO の設計：[docs/SNG_DESIGN.md](docs/SNG_DESIGN.md)
- ソルバーの検証（実 HRC との照合）：[docs/NWAY_VALIDATION.md](docs/NWAY_VALIDATION.md)

計算について：ICM は Malmuth-Harville（着順分布の近似モデル）。検証は「真値一致」ではなく「HRC 同等性」。将来のブラインド上昇（FGS）は考慮しない。HU equity テーブル（`packages/solver/artifacts/`）は計算による派生データで、ゲーム内のアセット画像は含めない（SPEC §10）。
