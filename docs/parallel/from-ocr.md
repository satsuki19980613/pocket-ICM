# 受信箱: OCR → MAIN

OCR セッションだけが**書く**。MAIN セッションは**読むだけ**（絶対に編集しない）。
最下部に追記。書式: `## [YYYY-MM-DD HH:MM] 件名` → 本文。

---

## [2026-09-07 着手] OCR 精度強化を開始（現状実測から）

MAIN へ。OCR セッション着手します。所有権・凍結（`prefillFromScreenshot` 戻り値4フィールド／`BoardForm`）は厳守。UI 変更が要る時は §4 で REQ を書きます。

**現状精度の実測（AI目視GT vs OCR end-to-end, `scripts/accuracy.ts`）**:
- **Android 実機 2730×1260**（`accuracy.groundtruth.json`, 20フレーム）: 判定100% / 全フィールド完全一致85% / stack・bet・action 97.8% ＝ 実用水準。
- **iOS 実機 1792×828**（`accuracy.iphone.groundtruth.json`, 2フレーム, `--auto`）: 判定100%だが **stack 50% / action 50%**。上段(TL/TR)・BL 席で stack 先頭桁欠落（19.2→9, 21.2→1）＋ fold 誤検出。iOS はアスペクト 2.164＝Android と同一の単純縮小なのに局所ズレ。
- **多機種 HTMLモック**（`accuracy.multidev.groundtruth.json`, 16フレーム, `--auto`）: 判定12.5% と壊滅（4/3/HU-max・iPhone SE=16:9）。ただしこれは合成モックで実ゲームの席配置と一致しない可能性があり、優先度は実機より下と判断。

**方針**: まず実機 iOS（さつきの実デバイス出力）の局所ズレを根因特定→修正→再実測。これが「実用に耐えない」の実機主因と見ています。多機種モックは別途切り分け。所有ファイル（`packages/ocr/**`・`app/src/ocr/**`・`ocrPrefill.ts`）内で完結させます。

---

## [2026-09-07 実装完了] BB表示ゲート＋実機iOSのBB精度を大幅改善（未commit）

MAIN へ。新仕様（BB表示のみ取り込み・§5.2）を実装し、あわせて実機 iOS の BB 精度を強化しました。**OCR 所有ファイルのみ変更・凍結interface不変**（`prefillFromScreenshot` 戻り値4フィールド／`BoardForm` そのまま。App 変更不要）。

**新仕様の実装（依頼どおり）**:
- `app/src/ocr/prefill.ts`: 抽出直後に `reads.displayMode !== 'bb'` なら `ok:false`＋`issues:[CHIPS_MODE_ISSUE]` を返す早期ゲート。文言はあなたの案どおり。定数 `CHIPS_MODE_ISSUE` を export（テストで固定）。`prefill.test.ts` に回帰テスト追加。

**iOS BB 精度の強化（機種非依存の堅牢化＋較正, いずれも Android 回帰ゼロ）**:
1. `bbAmount.ts` … 末尾 "BB" 除去を **letters(B) の NCC アンカー**方式に（右端の隣接 B ペアを BB と特定）。手番シェブロン ▼ 等が BB の右に付いても数値化しない（実 iPhone TR 27.7→17.788 の主因を解消）。B ペアが取れない時は旧「末尾2 tall」にフォールバック＝クリーン frame は挙動不変。さらに先頭桁が発光弧と融合し脱落する疑い（左端の超幅広 tall 塊）を検出して低信頼フラグ（サイレント誤読を確認画面に回す）。
2. `frameProfile.ts` … BL スタック領域が数字にタイト過ぎ先頭桁が左端で切れていた（Android は conf0.37、iPhone は "10.9"→"0.9"）。左に余白（x0.182/w0.074）→ 両機種で正読＆conf≈1.0。
3. `contentRect.ts`＋`extract.ts` … コンテンツ矩形の自己整合スコアに **hero 手札の認識信頼度**を強アンカーとして追加。数字スタックだけのスコアは「位置ズレでも自信を持って読めるゴミ」を選び、cr が僅かにずれ hero KJo→K6o を誤読していた。hero カードは常在・位置敏感なので整列が安定（ranks 未指定＝従来動作＝Android は全画面早期returnで無影響）。

**実測（AI目視GT vs OCR end-to-end, `scripts/accuracy.ts`）**:
- **Android**（`accuracy.groundtruth.json` 20フレーム, chips混在の参考込み）: 判定100% / 完全一致 **85→90%** / stack **97.8→98.9%** / 他維持 ＝ **回帰ゼロ・微改善**。
- **実機 iOS BB**（`accuracy.iphone.groundtruth.json` 2フレーム, `--auto`）: verdict/heroPos/playersLeft/blinds/ante/pot/heroHand/bet/occupancy **すべて100%**、stack **50→66.7%**。残る stack 誤り（TL/TR の発光弧・左端クリップ計4件）は**低信頼フラグ済み**＝確認画面で強調され利用者修正に回る（プリフィル原則を維持）。action の fold 誤検出（cardState の青メトリクスが Android と iOS で非互換）は残るが、root は6-way復元なので **verdict/playersLeft には影響せず**受理結果は正常。

tsc -b clean / OCR 125→**131 tests green**（bbAmount＋prefill 回帰追加）/ app ocr tests green。**push はしません**（§デプロイ禁止を厳守）。

**残（さつきに相談中）**: 完全な iOS 対応には ①cardState の active/folded を機種非依存化（青の明度が iOS で低い）②発光弧に融合する先頭桁の分離、が要る。いずれも実機 iOS フィクスチャが2枚では過学習リスク大 → **BB表示の実機 iPhone スクショの追加提供**をさつきに依頼予定。多機種HTMLモックは実ゲームの席配置と一致しない疑いがあり優先度は実機より下と判断。
