# OCR 改善データ基盤 — 解析の回し方（運用手順）

最終更新: 2026-09-09。対象: SPEC v3 §12（OCR 改善データ基盤）・§4.2（管理画面）・§7.2（画像保持方針）。
関連実装: `packages/app/src/supabase/ocrLog.ts`（記録側）、`packages/app/src/supabase/admin.ts` /
`packages/app/src/admin/format.ts`（管理画面の集計）、`packages/ocr/scripts/pullFailures.ts`（取得スクリプト・本書の対象）、
`packages/ocr/scripts/verifyFrame.ts` / `extractFrame.ts`（較正ハーネス）。

**目的**: 実利用で集まるスクショ（とりわけ OCR が失敗・低信頼だったもの）を資産化し、
OCR を継続的に強化する。βテスト中は利用者数・件数とも小さいので、月1〜週1くらいの頻度で
このドキュメントの手順を回す想定。

---

## 0. 全体の流れ

```
サーバ (ocr_reads + images/spot-images)
   │  pullFailures.ts（service_role キー・ローカル実行のみ）
   ▼
packages/ocr/local-fixtures/failures/
   │  index.csv を表計算で眺める（機種別・原因別に切る）
   ▼
怪しいグループを数枚ピックアップ
   │  較正ハーネス（verifyFrame.ts / extractFrame.ts）で再現
   │  ★ AI 目視 vs OCR 出力の照合が鉄則（[[ocr-accuracy-verification]]）
   ▼
原因を切り分けて実装を直す
   │  テストで固定（accuracy.groundtruth.json 等に追加）
   ▼
リグレッションが増えない形でコミット
```

管理画面（`Admin.tsx`）には**件数と内訳だけ**を出し、画像そのものは一覧表示しない
（プライバシー上の方針・SPEC §12.3）。詳細解析は必ずこの手順（ローカルスクリプト）で行う。

---

## 1. 取得: `pullFailures.ts`

サーバの `ocr_reads`（成功・失敗を問わず1行記録される。§12.1）と、それに紐づく元画像
（`images` テーブル＋ `spot-images` private バケット）を、さつきのローカル環境から
`packages/ocr/local-fixtures/failures/`（gitignore 済み）へ落とす。

### 認証

service_role キーを**環境変数からのみ**渡す。キーは RLS を無視して全件を読み書きできる
強い権限を持つため、**リポジトリに書かない・コミットしない・Slack 等にも貼らない**。
Supabase ダッシュボード → Project Settings → API → `service_role` からコピーする。

```
SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=xxxxxxxxxxxxxxxx
```

未設定のまま実行すると、使い方だけ表示してすぐ終了する（誤って空実行しない設計）。

### 実行例（リポジトリのルートから）

```sh
# 直近30日の失敗（ok=false）を最大100件（既定値のまま）
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... npx tsx packages/ocr/scripts/pullFailures.ts

# 直近全部（8月以降）を多めに、低信頼（成功はしたが要確認）だけ
npx tsx packages/ocr/scripts/pullFailures.ts --since=2026-08-01 --limit=300 --only=lowconf

# 期間内の全 ocr_reads を棚卸し（成功も含む。分布を見たい時）
npx tsx packages/ocr/scripts/pullFailures.ts --only=all
```

`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` は一度シェルに export しておけば、以降は
オプションだけで済む（`export SUPABASE_URL=... ; export SUPABASE_SERVICE_ROLE_KEY=...`）。

### 出力

`packages/ocr/local-fixtures/failures/` 直下（フラット）に:

| ファイル | 内容 |
|---|---|
| `<ocr_read_id>.<ext>` | 元画像（webp/jpg/png のいずれか。`image_id` が無い・取得失敗なら無し） |
| `<ocr_read_id>.json` | `ocr_reads` の行そのまま（`issues`/`raw_reads`/`state`/`final_state`/`corrections`/`device` 等すべて） |
| `index.csv` | 一覧（`id, created_at, ok, display_mode, issue_codes, aspect, device`） |

---

## 2. 眺め方: `index.csv` で原因別・機種別に切る

`index.csv` を Excel やスプレッドシートで開き、次のような切り方で眺める。

- **`issue_codes` でフィルタ/ピボット** → どの棄却理由が多いか一目でわかる
  （`street_not_preflop` / `display_mode_chips` / `out_of_scope_raise` / `out_of_scope_limp` /
  `walk` / `seat_read_failed` / `checksum_mismatch` など。理由コードは §12.2 で固定されている
  ので、メッセージ文言ではなくこのコードで集計すること）。
- **`aspect` でグルーピング** → 画面のアスペクト比（=機種・解像度の代理指標）ごとに失敗率が
  偏っていないか（実績: 2.44 の超ワイド機種はベット領域較正が弱いことがわかっている。
  `docs/OCR_MATERIALS_NEEDED.md` 参照）。
- **`device` 列**（JSON文字列: `ua`/`dpr`/`w`/`h`/`aspect`）→ 同じ `aspect` でも実機の解像度
  （`w`/`h`）や DPR が違うと座標較正がズレることがあるため、怪しいグループが見つかったら
  ここまで見て機種を特定する。
- **`display_mode`** → `chips`（弾いて正しい・対象外条件2）と、`bb` なのに落ちている行を
  区別する。後者が本当の OCR バグ候補。

ここで「怪しいグループ（同じ issue_code・同じ aspect が固まっている等）」を見つけたら、
そのグループから数枚（3〜5枚が目安）を次のステップでピックアップする。

---

## 3. 較正ハーネスでの再現

ピックアップした画像を、既存の較正ハーネスにそのまま食わせて再現する。

```sh
cd packages/ocr
npx tsx scripts/extractFrame.ts <file>            # RawReads → runOcrPipeline を通しで表示
npx tsx scripts/verifyFrame.ts <file> assets/digits.json "herostk=8478,pot=2400,..."
```

**注意（現状の制約）**: `verifyFrame.ts` / `extractFrame.ts` は自前 PNG デコーダ
（`pngCodec.ts`）に依存しており、**PNG しか読めない**。一方 `pullFailures.ts` が落としてくる
画像はサーバ保存の圧縮版なので **webp（多くの場合）か jpg** になっている
（§7.2: 端末内で WebP q0.8 に変換してアップロード。WebP 非対応環境のみ JPEG）。

そのため較正ハーネスに渡す前に、落とした画像を一度 PNG へ変換すること
（例: ブラウザで画像を開いて「名前を付けて保存」→ PNG、または手元にあるどれかの画像編集
ツール・`ffmpeg`/`cwebp` があればそれで変換）。この変換ステップは
`pullFailures.ts` の責務には含めていない（ゼロ課金・依存ゼロの方針上、変換用ライブラリを
新規に足していない）。変換後のファイル名は `<ocr_read_id>.png` のように揃えておくと、
同名の `.json`（真値の手がかり＝§4 参照）と対応が取りやすい。

---

## 4. AI 目視 vs OCR 出力の照合（鉄則）

**[[ocr-accuracy-verification]]**: OCR の精度検証は、必ず AI がその画像を目視した結果と
OCR の出力を突き合わせて行う。OCR の出力だけを見て「合っていそう」と判断しない。

過去に実際、目視側が J♥ を J♦ と読み間違えていたのを OCR 側の出力が捕捉した実績がある
（逆に OCR が壊れていて目視が正しいケースもある）。**どちらが正しいかは画像を直接見るまで
わからない**という前提で、必ず両方を並べて確認すること。

具体的には:
1. 落とした画像（変換後の PNG）を実際に開いて、フィールドごとに真値を目視で読む。
2. `verifyFrame.ts` の第3引数（`"field=truth,..."`）に真値を渡し、一致/不一致を機械的に出す。
3. 不一致が出たら、まず画像をもう一度見て「本当に不一致か」を疑う（誤読の可能性は両方向にある）。
4. 一致しない理由が読み取り領域・しきい値・スケール差など実装側の問題だと確定したら、
   `packages/ocr/scripts/tuneField.ts` 等で領域・パラメータを調整する。

---

## 5. `corrections`（暗黙の正解ラベル）の読み方

各 `<ocr_read_id>.json` には、`ocr_reads` テーブルの列がそのまま入っている。特に重要なのが:

- **`state`**: OCR が復元した盤面（成功時）。
- **`final_state`**: 条件確認画面を経て、**実際に計算へ使われた**最終入力。
- **`corrections`**: `state` → `final_state` の差分（`packages/app/src/supabase/ocrLog.ts` の
  `diffStates` が生成する `OcrCorrections` 型。`seats[]` は `{ pos, field: 'stack'|'bet'|'state', from, to }`
  の配列、それ以外は `playersLeft` / `heroPos` / `heroHand` / `blinds` / `ante` の `{from,to}`）。

利用者が確認画面で「ここは違う」と直した値が入っているので、**`corrections` が非空の行は
「OCR が間違えていた」ことがほぼ確定している**（利用者が誤って直した可能性はゼロではないが、
稀）。`corrections` が空で `ok=false` の行は「そもそも復元できなかった」行（`issues`/`raw_reads`
を見て、どのフィールドの読み取りが原因で棄却されたかを追う）。

`raw_reads`（§12.2 固定スキーマ: `seats[] = {id,pos,isHero,isButton,occupancy,action,stack,bet}`
それぞれ `{value,conf}`）と `low_confidence`（しきい値未満だったフィールド名一覧）も合わせて見ると、
「読めてはいたが自信が無かった」フィールドと「まったく読めなかった」フィールドを区別できる。

---

## 6. 直したらテストで固定

原因を直したら、同じ失敗を再発させないように**必ずテストへ落とす**。

- 実画像を使った精度回帰は `packages/ocr/scripts/accuracy.ts` と
  `accuracy.groundtruth.json` / `accuracy.iphone.groundtruth.json` /
  `accuracy.multidev.groundtruth.json`（機種別）に真値エントリを追加する形が既存の流儀。
  変換した PNG を `packages/ocr/local-fixtures/` に置き、対応する真値を groundtruth に足す。
- 単体の領域・しきい値調整は `packages/ocr/src/*.test.ts`（Vitest）に unit テストを足す。
- 直した後は `npm test`（root）で既存の全テストが green のままであることを確認する
  （多機種の verdict が退行していないか、特に注意する）。

---

## 運用上の注意

- service_role キーは**このスクリプトのローカル実行専用**。アプリのビルド成果物・
  Cloudflare Workers の環境変数には絶対に混ぜない。
- 落とした画像は他プレイヤーの手札等が写り得る個人情報に近いデータ（SPEC §8）。
  `local-fixtures/` は gitignore 済みだが、**このフォルダごと外部へ共有しない**。
- OCR に失敗・低信頼だった画像は §7.2 の方針でサーバ上は無期限保持されるため、
  何度でも同じ手順で取得し直せる（取りこぼしを心配して急いで一括処理する必要はない）。
