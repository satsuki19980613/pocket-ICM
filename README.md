# Black Ops ICM

[![CI](https://github.com/satsuki19980613/pocket-ICM/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/satsuki19980613/pocket-ICM/actions/workflows/ci.yml)
[![Live](https://github.com/satsuki19980613/pocket-ICM/actions/workflows/live.yml/badge.svg?branch=master)](https://github.com/satsuki19980613/pocket-ICM/actions/workflows/live.yml)
[![CodeQL](https://github.com/satsuki19980613/pocket-ICM/actions/workflows/codeql.yml/badge.svg?branch=master)](https://github.com/satsuki19980613/pocket-ICM/actions/workflows/codeql.yml)

ポーカーチェイスのクラブマッチ（6 人 SNG・固定ペイアウト +5/+3/+2/+1/0/−1pt）向けの **push/fold ICM 復習ツール**。招待キーを持つクラブのメンバーだけが利用できる Web アプリ（PWA）である。

**リアルタイムアシスタンス（RTA）は実装しない。** プレイ中の支援は一切提供しない。

**公開サイト**：https://pocket-icm.wsk641.workers.dev/

## 機能

- **ICM** — スクリーンショットか手入力で盤面を入力すると、Nash 均衡の push/fold と EV 差を算出する。計算は端末内で行う。
- **Home** — 計算結果の公開、スレッド・コメント・♡、Slumbot のランキング。
- **Training** — Slumbot とのヘッズアップ、メンバー同士の SIT & GO、AOF ドリル、成績とハンド履歴。
- **記録・設定** — 自分の計算の記録、表示名・アイコン、アカウントの削除。

## 計算モデル

- ICM は Malmuth-Harville（着順分布の近似モデル）を用いる。
- 検証の基準は「真値との一致」ではなく「HRC との同等性」である。
- 将来のブラインド上昇（FGS）は考慮しない。
- HU equity テーブル（`packages/solver/artifacts/`）は計算による派生データであり、ゲーム内のアセット画像は含まない（SPEC §10）。

## セキュリティとプライバシー

### 要約

- **招待キーが無ければ会員になれない。** 会員以外はデータを一切読めない。
- **メールアドレスと本名は求めない。** ログインはユーザー名とパスワードのみで行う。
- **スクリーンショット・非公開の計算結果・自分の手札は、他の会員に見えない。**
- **SIT & GO では、他人の手札と山札が見えない**（ショーダウンで公開された札を除く）。
- **課金・広告・アクセス解析は無い。** 自サイト以外のスクリプトは実行されない設定である。
- **以上の内容の一部は自動検証で継続的に確認している。** 結果は上部のバッジで公開している。

**制約**：運営者（管理者とサーバーの所有者）は、サーバー上の情報をすべて閲覧できる。非公開の計算結果やスクリーンショットも、不具合や読み取りの誤りの調査のために確認することがある。運営者を信頼できるクラブ内で使うアプリである。

### 取り扱う情報

| 情報 | サーバーへの保存 | 運営者による閲覧 | 他の会員への表示 |
|---|---|---|---|
| メールアドレス・本名 | **求めない・保存しない**（ログイン用に、実在しない宛先 `<ユーザー名>@users.pocket-icm.app` を内部で生成） | — | — |
| パスワード | Supabase の認証基盤がハッシュで保存 | 元のパスワードは不可 | 不可 |
| ユーザー名・表示名・アイコン画像・枠の色・バッジ | 保存 | 可 | 可 |
| IP アドレス・ブラウザの種類 | アプリは保存しない。ただし Supabase の認証基盤がログイン記録として保存する（Supabase の標準動作） | 可 | 不可 |
| 計算した局面と結果 | 保存（自分で削除できる） | 可 | **公開を選んだもののみ** |
| スクリーンショット | 端末で縮小した版（長辺 1600px）のみ保存。原本は送信しない。**90 日で削除** | 可 | 不可 |
| 読み取れなかったスクリーンショット | 読み取りの改善のため**無期限に保持**（記録を削除しても残る。アカウント削除で削除） | 可 | 不可 |
| スクリーンショットの読み取り記録（読み取った値・修正した値・端末の種類と画面サイズ） | 保存 | 可 | 不可 |
| スレッド・コメント・♡・スレッドの画像 | 保存（自分で削除できる） | 可 | 可 |
| Slumbot の成績（ハンド数と収支の合計） | 保存 | 可 | 可（ランキング） |
| Slumbot のハンド履歴 | 保存 | 可 | 不可 |
| SIT & GO の進行中の卓（山札・全員の手札を含む） | Cloudflare に保存（**終了した卓も残る**） | 可 | 自分の手札と公開済みの札のみ |
| SIT & GO の記録（試合・ハンド・順位） | 保存 | 可 | 同じ試合の参加者（他人の手札は公開済みのもののみ） |
| SIT & GO の自分の手札の記録 | 保存 | 可 | 不可 |
| アプリのエラー記録（エラー内容・画面・端末の種類） | 保存（**90 日で削除**） | 可 | 不可（送信した本人も読めない） |
| 設定・Slumbot のトークン | **保存しない**（端末内のみ） | 不可 | 不可 |

外部サービスに送信される情報：

- **Supabase** — 認証・データベース・画像の保存。通信を受けるため、接続情報（IP アドレスなど）が送信される。
- **Cloudflare** — サイト配信、Slumbot の中継、SIT & GO のサーバー。接続情報が送信される。
- **Google Fonts** — フォントの読み込み時。サイトを開くと Google に接続情報が送信される。
- **Slumbot**（slumbot.com） — Slumbot との対戦時。自サイトのサーバーが中継し、送信されるのは Slumbot のトークンと打った手のみ（ログインのパスワードは中継しない）。

### 保証範囲と制約

保証する事項：

- 招待キーを持たない人は会員になれない（キーは 1 回限り・有効期限付きで、会員数にも上限がある）。
- 会員以外や未ログインの利用者にデータを読まれない。
- 他の会員に、スクリーンショット・非公開の計算結果・読み取り記録・Slumbot の履歴・自分の手札を見られない。
- SIT & GO で、他の参加者に手札と山札を見られない。配札を予測されない。
- アカウントを削除すると、画像ファイルと記録がまとめて削除される。
- メールアドレスと本名を運営者に知られない。

制約：

- **運営者はサーバー上の情報をすべて閲覧できる。** 非公開の計算結果・スクリーンショット・読み取り記録・SIT & GO の山札と全員の手札を含む。
- **表示名・アイコン・投稿・公開した結果・Slumbot の成績は、全会員に表示される。**
- **読み取れなかったスクリーンショットは、アカウントを削除するまで残る。**
- **SIT & GO の終了した卓（山札と全員の手札）は Cloudflare に残る。** 削除処理は未実装である。
- **SIT & GO の部屋の作成者がアカウントを削除すると、その試合の記録は他の参加者の分も削除される。**
- **Slumbot のランキングは、端末が送信する値をそのまま集計する。** 1 ハンドあたり ±200bb を超える値は拒否するが、その範囲内の改ざんは防げない。
- **SIT & GO のサーバーにはレート制限が無い。** 1 人が保有できる部屋は 1 つまでである。
- **会員による画像の大量アップロードでストレージが埋まることは、完全には防げない。** 古い画像を毎週削除して緩和している。
- **外部サービス（Supabase・Cloudflare・Google・Slumbot）における取り扱いは、各社の規約に従う。**
- **第三者による監査は受けていない。** 個人による運営であり、検証は下記の自動検証とテストに限られる。

### 脅威モデルと対策

想定する脅威は、他の会員の記録や手札を覗こうとする会員、侵入を試みる非会員、および一般的な Web 攻撃である。ブラウザは信頼しない。誰が何を読めるかはデータベースが決定し、SIT & GO のルールの判定と配札はサーバーが行う。

| 対策目標 | 実装 | 根拠 |
|---|---|---|
| 招待された人だけを会員にする | 登録はサーバーの関数だけが行い、招待キーを検証してから作成する。キーはハッシュで保存し、1 回使用すると無効になる | [signup/index.ts](supabase/functions/signup/index.ts)・[0001_schema.sql](supabase/migrations/0001_schema.sql)・[0008_security.sql](supabase/migrations/0008_security.sql)（`register_member`） |
| 非会員への非公開・他人の記録の秘匿 | 全テーブルで RLS を使う。読めるのは会員だけで、非公開のものは本人だけ | [0008_security.sql](supabase/migrations/0008_security.sql)・[0010_hu_hands.sql](supabase/migrations/0010_hu_hands.sql)・[0011_sng.sql](supabase/migrations/0011_sng.sql)。外部から検証する [scripts/live-check.mjs](scripts/live-check.mjs) |
| 画像の秘匿 | 画像のストレージはすべて非公開。会員には有効期限 1 時間の署名付き URL だけを渡す。データベースに登録できる画像の参照は「このアプリの本人のフォルダ」の形式に限る | [0008_security.sql](supabase/migrations/0008_security.sql)・[storageUrls.ts](packages/app/src/supabase/storageUrls.ts)（テスト付き） |
| 本人以外による操作の防止 | 管理者フラグとユーザー名は本人にも書き換えられない。SIT & GO のサーバーは、接続のたびにログインを Supabase で検証し、5 秒以内に認証しない接続を切断する | [0008_security.sql](supabase/migrations/0008_security.sql)・[worker/sng/auth.ts](worker/sng/auth.ts)・[worker/sng/wsAuth.ts](worker/sng/wsAuth.ts) |
| 手札と山札の秘匿 | ブラウザに送る卓の情報から山札と手札を除き、手札は本人の接続にだけ送る。記録でも、手札は本人だけが読めるテーブルに分離する | [view.ts](packages/sng/src/engine/view.ts)・[worker/sng/table.ts](worker/sng/table.ts)・テスト [table.test.ts](packages/sng/src/engine/table.test.ts) |
| 配札の予測防止 | シャッフルと部屋番号に暗号論的乱数（`crypto.getRandomValues`）を使う | [worker/sng/table.ts](worker/sng/table.ts)・[cards.ts](packages/sng/src/engine/cards.ts)・[worker/sng/router.ts](worker/sng/router.ts) |
| 中継の悪用防止 | Slumbot の中継は対戦に必要な 2 つの操作だけを通し、サイズと待ち時間に上限を設ける | [worker/index.ts](worker/index.ts) |
| XSS の防止 | 画面は React がテキストとして表示する。加えて、自サイト以外のスクリプトを実行させない | [packages/app/public/_headers](packages/app/public/_headers) |
| 画像の蓄積の抑制 | 期限切れの画像と、容量を使いすぎた会員の古い画像を毎週削除する | [purge-images/index.ts](supabase/functions/purge-images/index.ts)・[purgePlan.ts](supabase/functions/_shared/purgePlan.ts)・[warm-ping.yml](.github/workflows/warm-ping.yml) |
| アカウント削除後に残さない | 画像ファイルを先に削除し、成功したときだけアカウントと記録を削除する | [delete-account/index.ts](supabase/functions/delete-account/index.ts)・[userFiles.ts](supabase/functions/_shared/userFiles.ts)（テスト付き） |
| 秘密情報の管理 | リポジトリには置かず、Cloudflare・Supabase・GitHub のシークレット設定で管理する | [DEPLOY.md](DEPLOY.md)・[.dev.vars.example](.dev.vars.example) |

運用手順（本番への反映・ダッシュボードの設定・検証方法）は [docs/SECURITY.md](docs/SECURITY.md) に記載している。

### 自動検証

上部のバッジは、次の検証の結果を示す（安全性を保証するものではない）。

| 検証 | 内容 | 実行タイミング |
|---|---|---|
| [CI](https://github.com/satsuki19980613/pocket-ICM/actions/workflows/ci.yml) | 型検査とテスト（手札の秘匿、画像の参照の検証、アカウント削除の手順を含む） | コード変更時 |
| [Live](https://github.com/satsuki19980613/pocket-ICM/actions/workflows/live.yml) | 本番サイトの疎通、セキュリティヘッダーがリポジトリの設定どおりであること、Worker が不要なリクエストを通さないこと、未ログインの利用者に Supabase がテーブル・画像一覧・管理用の関数を一切返さないこと、下記 Observatory の評価 | 毎週・配信やサーバーの変更時 |
| [CodeQL](https://github.com/satsuki19980613/pocket-ICM/actions/workflows/codeql.yml) | GitHub CodeQL による静的解析 | コード変更時・毎週 |
| [Mozilla HTTP Observatory](https://developer.mozilla.org/en-US/observatory/analyze?host=pocket-icm.wsk641.workers.dev) | 公開サイトのセキュリティヘッダー。**A+**（125 点、12 項目すべて合格。2026-10-11 に Live で測定）。A+ 未満で Live が失敗する | Live が毎週測定。リンク先で随時再測定できる |

このほか、依存パッケージの脆弱性を Dependabot で通知している。

### 脆弱性の報告

[SECURITY.md](SECURITY.md) を参照。リポジトリの Security タブから非公開で報告できる。

### 記載方針

本節は次の指針に基づいて構成している。

- 要点を先に、詳細を後に示す（英国 ICO の[段階的な情報提供](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/the-right-to-be-informed/what-methods-can-we-use-to-provide-privacy-information/)）
- 取り扱う情報を定型の表で示す（カーネギーメロン大学の[プライバシーの「栄養成分表示」の研究](https://doi.org/10.1145/1753326.1753561)。Apple・Google のアプリストアの表示も同じ考え方）
- 保証範囲と制約、想定する脅威と対策の根拠を示す（[OpenSSF Best Practices](https://www.bestpractices.dev/en/criteria/1)）
- 報告窓口と実施中の検証を示す（[GitHub のリポジトリのベストプラクティス](https://docs.github.com/en/repositories/creating-and-managing-repositories/best-practices-for-repositories)）

## 開発

### 必要環境

- Node.js 20 以上

### コマンド

| コマンド | 内容 |
|---|---|
| `npm install` | 依存パッケージのインストール |
| `npm test` | 全パッケージの単体テスト（Vitest） |
| `npm run typecheck` | 型検査 |
| `npm run dev --workspace @oshihiki/app` | アプリの開発サーバー（Vite。ポート 5173） |
| `npm run build --workspace @oshihiki/app` | アプリの本番ビルド（PWA の生成を含む） |
| `node scripts/live-check.mjs` | 本番の外部からの検証（Live と同じ） |

### ディレクトリ構成

npm workspaces のモノレポ（TypeScript）。

```
packages/
  core/     データ契約（169 ハンドクラス・ポジション・盤面と解のスキーマ）
  solver/   MH-ICM・ハンド評価・equity テーブル・push/fold Nash（HU〜6 人）
  harness/  HRC 照合ハーネス
  ocr/      スクリーンショットの読み取り
  sng/      SIT & GO のルール（サーバーとブラウザで共有）
  app/      PWA（React + Vite）。ソルバーは Web Worker で端末内実行
worker/     Cloudflare Worker（Slumbot の中継・SIT & GO の Durable Objects）
supabase/   マイグレーション・Edge Functions
```

### 関連資料

- 仕様：[SPEC.md](SPEC.md)
- 実装計画：[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)
- デプロイ（Cloudflare Workers Builds・Supabase）：[DEPLOY.md](DEPLOY.md)・[supabase/README.md](supabase/README.md)
- SIT & GO の設計：[docs/SNG_DESIGN.md](docs/SNG_DESIGN.md)
- ソルバーの検証（実 HRC との照合）：[docs/NWAY_VALIDATION.md](docs/NWAY_VALIDATION.md)
