# OCR パイプライン設計（Phase 2 / packages/ocr）

版: 2026-09-02 / 状態: **画像非依存の純ロジック＝完成（55 tests green）**、実画像較正＝未（Phase 0 素材待ち）

## 位置づけ（SPEC §6.1）

**手入力が「正」、OCR はその手入力フォームを自動で埋めるプリフィル。** OCR がどれだけ失敗しても、
条件確認画面で全項目修正でき、手入力のみでリリースラインは常に維持される。したがって OCR の出力先は
`BoardForm`（＝ `packages/app` の手入力フォーム）であり、最終的に必ず `Confirm` 画面を経由する。

## パッケージ構成

`packages/ocr`（新規, `@oshihiki/ocr`, 依存: core + zod）。画像非依存の純ロジックと、
画像アルゴリズムの中核を実装。**実スクショから作るテンプレ・座標は含めない**
（SPEC §10 / R-10。`local-fixtures/` と `templates/` は `.gitignore` 済み）。

| モジュール | 役割 | Plan |
|---|---|---|
| `positionDerivation.ts` | D ボタン＋生存席 → ポジション導出（HU の SB=BTN、empty 除外） | 2-4 |
| `gate.ts` | ストリート表示 → preflop 以外を弾く（日英・表記ゆれ耐性） | 2-2 |
| `spotReconstruction.ts` | 画面の実ベット → **root push/fold spot 復元** ＋ 対象外検出 | 2-6/2-7 |
| `confidence.ts` | 信頼度集約 ＋ ポット・チェックサム（画面値） | 2-8 |
| `pipeline.ts` | 上記を統合し `BoardState` ＋強調情報を返す | 2-* |
| `raster.ts` | グレースケール・crop・双一次リサイズ・Otsu・二値化 | 基盤 |
| `match.ts` | 正規化相互相関（NCC）＋ best-match ＋ 信頼度 | 基盤 |
| `digits.ts` | 数字ストリップの縦投影セグメント＋テンプレ組み立て | 2-5/2-6 |
| `cards.ts` | 52 種カードマッチ＋2 枚→ハンドクラス表記の組み立て | 2-3 |
| `layout.ts` | 割合矩形→px 変換・領域解決（座標プロファイルは較正で埋める器） | 2-* |
| `packages/app/ocrPrefill.ts` | `BoardState` → `BoardForm` プリフィル（round-trip） | 3-3 |

## 中核の設計判断

### root spot 復元（最重要, spotReconstruction.ts）

solver は「全席 live・ブラインド投函済み・未開」の **root を全木で解く**
（`nwaySolver`: `T = stack + bet + antePaid`、`state !== 'empty'` の席のみ対象。誰が既にフォールド/
シューブしたかは結果画面のノード選択で扱う）。よって OCR は途中状態のスクショから root を逆算する:

```
putIn_i      = folded ? 席のブラインド義務 : screenBet_i     // フォールド済みのデッド分を含む
fullBehind_i = screenStack_i + putIn_i                       // ante は solver が別途加算
rootStack_i  = fullBehind_i - blindOb_i
rootBet_i    = blindOb_i    (SB=sb, BB=bb, それ以外 0)、state = 'live'
```

`T = rootStack + rootBet + antePaid = screenStack + putIn + ante` が配布時の全持ち込みに一致する
（シューブ済み席 `screenStack=0, screenBet=全額` も、フォールド済み席も正しく root に戻る）。

### 対象外検出（§6.5, 2-7）

push/fold Nash はフォールドとオールインしか持たない。したがって:
- **非オールインの自発コミット**（`screenBet - blindOb > 0` かつ非オールイン）→ リンプ/ミニレイズ/3bet として弾く。
- **hero が BB で pot 未レイズ**（誰もオールイン/自発コミットしていない）→ ウォーク（no decision）として弾く。

### ポット・チェックサム（§6.3, 2-8）

`Σ(各席の拠出) + アンティ寄与 ≒ ポット`。不一致なら `pot` と各 `bet` の信頼度を下げ、条件確認画面で強調。
**注意（較正対象）**: OCR の `pot` 読み取りが「中央ポットのみ」か「場に出た総額」かは実機表示に依存。
現状は総額前提の理論値で突き合わせ、tol は golden dataset で調整する。

### テンプレートマッチ（2-3/2-5）

描画フォント・カードデザインが固定なので学習器不要。**NCC**（輝度のオフセット・スケールに不変）で
装飾品や軽い明度差に頑健。候補は各テンプレサイズへ双一次リサイズしてから相関を取る。

## テスト（55, すべて green）

`positionDerivation.test.ts`(11) / `pipeline.test.ts`(14) / `imaging.test.ts`(21) /
`layout.test.ts`(6) / `app/ocrPrefill.test.ts`(3)。合成フィクスチャで全経路を検証:
2〜6 人・HU の SB=BTN・empty 除外・回転不変・シューブ/フォールド混在の root 復元・
リンプ/レイズ/ウォークの棄却・低信頼とチェックサム不一致の強調・NCC の同一/反転/平坦・
"12.5" の数字復元・A5s 等のハンド組み立て・`BoardState`↔`BoardForm` の round-trip・end-to-end。

## 残り（実画像＝さつきの Phase 0 素材が前提）

golden dataset・52 枚カード参照画像が揃ってから較正・検証する:
1. `layout.ts` の座標プロファイル較正（アスペクト比別）
2. 52 枚カードテンプレ＋数字グリフの初回生成フロー（利用者スクショから、リポジトリ非同梱）
3. 実領域抽出（フレーム→`RawReads`）と App の「スクショ添付」UI 有効化
4. 精度検証（2-3 100% / 2-5・2-6 目標精度 / Discord 圧縮・ノッチ耐性）
5. `pot` チェックサムの表示前提（中央 or 総額）の確定と tol 調整
