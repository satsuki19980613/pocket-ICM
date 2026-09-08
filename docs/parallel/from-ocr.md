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

---

## [2026-09-07 追加改善] 発光弧の帯除去でコーナー席スタックを改善（機種非依存・Android回帰ゼロ）

さつきの洞察（数字と装飾を分離する）を実装。実機 iPhone スクショ3枚で検証し、コーナー席の主因が **アバターの発光弧（白い横帯）が数字の上端に被って連結→幅広ブロブ化→落とされる**ことを実測特定。**色では分離不可（弧も白）だが、弧は「端に接する幅広の白帯」という幾何で分離できる**ので、`bbAmount.ts` に `stripEdgeBands`（端から連続する高fill行=帯を薄く剥がす。各端は領域高の12%までに制限し数字本体を食わない。帯が無ければ恒等）を追加し `readAmountBb` に前段組込み。

**実測**: 実機 iPhone BB stack **66.7→75%**（EC7CD106 の TL 21.2 が正読に・verdict/occupancy 100% 維持＝棄却なし）。E4073E5F TL も `9`→`18.2`（先頭桁復活）。**Android は完全無回帰**（stack 98.9%・全項目維持＝通常フレームでは stripEdgeBands 恒等）。ocr 127 tests green（帯除去の回帰テスト追加）。凍結interface不変。

**なお残る TR（両フレーム 27.7→17.788/26.2→16.2）は先頭 "2"→"1" 誤読＋シェブロンで、弧とは別要因**。ここと TL の詰めは実機 iPhone の追加フレームで閾値を validate すれば安定する見込み（2-3枚では過学習で片方を直すと片方が壊れることを実証済み＝だから“少数の追加”が必要）。

---

## [2026-09-07 大幅前進] iOS専用プロファイル＋弧ブリッジ刈り込みで実機iPhoneを解決

さつき指示（Sonnetサブエージェント複数で研究→実装、指揮＝私、AI目視必須）で実施。研究2本（同色発光帯の幾何分離／グリフ分割・NCC堅牢化）→ 実装検証2本（縦ランレングス開処理系＝readBand が iOS 12/12・Android 無回帰で勝者）→ 統合、の順で進めた。**OCR 所有ファイルのみ・凍結interface不変**（App変更不要）。

**実装（`packages/ocr` 所有内）**:
- `src/bbAmount.ts`: **trimArcBridge**（アバター発光弧が数字上端に融合して幅広ブロブ化する問題を、列の縦ラン長を支持信号に弧の橋だけを断ち、認識は原マスクから行う。suspect ゲート＝w/h>1.6 等を通った成分にのみ適用＝クリーン読みは不変）。研究＋実装検証で iOS 12/12・Android 65/66（現行同一）を確認したものを移植。
- `src/frameProfileIos.ts`（新規）: **iOS専用 FrameProfile `IOS_6MAX`**。Android CHIPS_6MAX を実測アフィン写像した土台に、stack 6席と hero card 領域を GT 駆動較正した実測値で上書き（機種差＝非アフィンを吸収）。
- `app/src/ocr/prefill.ts`: **解像度でプロファイル選択**（幅≥2400=Android→CHIPS_6MAX＋cr自動、<2400=iPhone→IOS_6MAX を full-frame canonical）。iPhone は full-bleed なので cr 探索不要＝**約10倍高速**化も同時達成。
- `scripts/accuracy.ts`: 本番と同じ選択を反映（検証パリティ）。

**実測（私が全フィールドを独立検証）**:
- **実機 iPhone BB**: stack **66.7→91.7%**、**heroHand 100%**、occupancy/playersLeft/heroPos/pot/blinds/ante/verdict **すべて100%**、所要 3000ms→**約200ms**。残り＝TC f1 の 111.2（conf0.13 でフラグ＝サイレントでない）・action の fold 誤検出（cardState の青メトリクスが機種依存＝別課題・root は6way復元なので構造には無影響）・BL bet 1件。
- **Android**: stack 98.9%・verdict 100%・完全一致90% ＝ **完全無回帰**（プロファイル選択で 2730 幅は従来経路のまま）。

tsc clean / ocr 127＋app ocr tests green。**push はしません**（デプロイ禁止厳守）。次の詰め（cardState機種横断・TC f1・bet較正）は実機 iPhone フレームが増えれば安定化できる。

---

## [2026-09-08 実装完了] fold判定を機種別指標に＋BB数値の飾り片弾きで実機iPhone全項目100%

さつき指示（両機種のさらなる精度向上・Sonnetサブエージェント活用）で実施。前回残の2大課題（action=fold 誤検出・数値の先頭桁の幻/脱落）を機種横断で解消。研究/実装をSonnet2本並行、指揮＝私が**両harnessを全フィールド独立再測＋AI目視照合**して統合（commit `ac4bf78`, 未push）。**OCR所有6ファイルのみ・凍結interface不変**（App変更不要）。

- `src/cardState.ts`＋`frameProfile.ts`／`frameProfileIos.ts`＋`extract.ts`: 非hero席の active/folded 判定を **`FrameProfile.handActive`（機種別指標）** に。Android=bright/0.06（旧既定＝**完全に挙動不変**）、iOS=strong/0.05（active strong≈0.10-0.14 / folded≈0.001, gap約89倍）。iOSはactiveでもbright≈0で旧ルールが全active席をfold誤判定していた。
- `src/bbAmount.ts`＋`extract.ts`: **NCCスコア下限 `scoreFloor`** を追加（飾り0.09/アイコン0.20/端スリバー0.32を実桁0.85-0.96と分離）＋小数点ゲート `0.6→0.45·glyphH` 厳格化。stack/betのみ0.45適用、**potは非適用**（143002のpot誤読でNaN化するとverdictが逆に壊れるため温存）。
- `src/frameProfileIos.ts`: BL `betBb` を左較正（先頭"0."の左端クリップ解消・`0.5→5` 誤読修正）。

**指揮側で捕捉した結合回帰（重要）**: cardState修正**単体**では E4073E5F が ○→×（棄却）に転落＝verdict/heroPos/playersLeft 100→50%。原因は「BLを正しくactiveにした結果、以前 fold で無視されていた **BL.bet 0.5→5 誤読**が表面化→SBに4.5bbの謎ベット→gate棄却」。エージェントAは「verdict不変」と誤報告（自分のbaselineが50%だった）。**私のbaseline照合で検出**し、B の betBb 較正と**セットで**統合して解消。

**実測（AI目視GT vs end-to-end, 私が独立再測）**: **実機iPhone 全フィールド100%（両フレーム 32/32・受理）** ＝ stack/bet/action/verdict/heroPos/playersLeft すべて改善。**Android bet 97.8→100%**（143002 TC.bet・114640 TL.bet 修正）、verdict 100%・完全一致 90% 維持で**回帰ゼロ**。tsc緑・ocr 128 tests緑。AI目視で case1(TC飾り宝石=phantom)・case2(BL "0.5"復活) を確認。
残: Android 143002 pot(3→44,飾り帯融合・floor非適用でverdict保護)・114640 folded席 BL.stack(NaN,棄却ケース)。**iOS較正は実機2枚のみ＝過学習注意**（追加フレームで再検証）。

---

## [2026-09-08 REQ受領] 在席判定のスタック依存＝6→5誤認識、着手します

MAIN へ。REQ「実機で6人卓が5人と誤認識（在席がスタック読取に依存）」受領。根因の指摘（`extract.ts:152` `occupied=Number.isFinite(stack.value)` → folded席でスタックNaN→席消失→playersLeft 6→5）は正確で、**既存Android GTに実例**があります（`114640` BL＝folded・stack NaN・現状 occ→empty 誤読, GT では occupied）。**本丸(1)＝在席をスタックから切り離す独立信号**を私の所有領域で実装します。

- **アプローチ**: 席ごとに独立 positive 在席信号（ネームプレート/カード裏/スタック領域の非背景密度）を新設し、`occupied = stack読める OR 在席信号あり`。スタックNaNの占有席は `lowConfidenceFields` で確認画面に回す（席は消さない）。凍結interface `{ok,form?,issues,lowConfidenceFields}` は現状維持＝**握手不要**。
- **検証規律**: 全Android GT（HU/3/4/5/6人の genuine empty 約30席を empty のまま維持＋114640 BL を occupied に）と実機iOS2枚（6席とも occupied 維持）で playersLeft 無回帰を私が独立確認。Sonnetサブエージェントで測定＋実装、私が指揮・両harness再測・AI目視。
- **(2)機種解像度分岐 `img.w>=2400`**: 新型iPhone（幅2532〜2868）がAndroid誤選択される穴は認識共有。ただし**さつきの実機失敗スクショが無いと正しく直せない/検証できない**（過学習回避）。→ **機種＋フルサイズ実機スクショの local-fixtures/ 追加を強く希望**（届き次第GT化して両方対応）。それまでは本丸(1)＝在席頑健化で「1席取りこぼし→NaNでも席維持」を先に効かせます。
- MAIN の安全網（Confirm の人数手修正）に感謝。応急として実害停止に有効です。完了は本欄へ。push/デプロイはしません（[[deploy-url]] ハザード厳守）。

## [2026-09-08 実装完了] 在席をスタック読取から分離（本丸1）＝6→5誤認識を解消（commit b2153df, 未push）

MAIN へ。REQ本丸(1)完了。**在席をスタック読取から切り離しました**。Sonnetサブエージェントで測定＋実装、私が両harness独立再測＋crop目視。**OCR所有4ファイルのみ**（`src/seatPresence.ts`新規＋test・`extract.ts`・`spotReconstruction.ts`）、**凍結interface不変＝握手不要**。

- **独立在席信号＝スタック矩形のエッジ密度**（前景ストローク量・解像度不変の割合）を主、プレート(actionZone)エッジ密度を保険でOR。実測分離(AI目視GT): empty max 0.002 / occupied min 0.089 / **occupied-NaN(114640 BL) 0.199** / iOS occupied min 0.119、閾値0.04。カード裏青(strong)は空席でも折れカード裏0.311で機種非頑健のため不採用（あなたの指摘通り）。
- `extract.ts`: `occupied = stack読める OR 在席信号あり`。**スタックNaNでも席は消さない**。presenceのみの占有席は `occupancy.conf=0.4`/`stack.conf=0` で **`${pos}.state` と `${pos}.stack` を lowConfidenceFields に**載せ確認画面で強調。
- `spotReconstruction.ts`: root逆算をNaNガード。

**実測（私が独立再測＋crop目視）**: Android occupancy **99.2→100%**（114640 BL の folded 席が empty→occupied 復活・crop で薄灰"31.7 BB"の実在を確認／空席cropは felt のみ＝信号0.002）、playersLeft 100%維持（**HU/3/4/5人の本物の空席は空席のまま**）、verdict 100%、完全一致90%維持で**回帰ゼロ**。実機iPhone 全フィールド100%維持。tsc緑・ocr 132 tests緑。

### ★要相談（握手 or さつき判断）: 占有NaN席の下流挙動
現状は **reconstruct-with-flag**＝占有NaN席を**仮値stack=0**で残し、`state`/`stack` を lowConfidenceFields で強調（§6.1: 確認画面で全項目修正可）。**懸念**: ユーザーが未修正で確定すると solver に 0 が渡る。実サンプルが棄却対象の 114640 BL のみで**有効フレームでは未検証**。
- 提案: **Confirm の「検出人数」ブロック同様、lowConfidenceFields に stack/state を含む席は"要入力"として確定前に赤字必須化**（未入力なら solve ボタン無効）だと黙って0で解く事故を完全に塞げます。MAIN 側UIで可能か教えてください。不可なら OCR 側を **reject-with-issue（「N席のスタックが読めません。人数と各スタックを手入力してください」）** に倒す選択もあり（プリフィルは失うが誤解ゼロ）。**どちらに倒すかご判断ください**。

### (2)機種解像度 img.w>=2400: 実機失敗スクショ待ち
本丸(1)で「1席NaNでも席維持」は効くので、さつきの実機で**6人が6人に出る確率は上がる**はず。ただしプロファイル自体が機種で外れている場合は座標総崩れで在席信号も外れ得る＝**根治には実機の失敗スクショ（機種名＋フルサイズ）が必須**。引き続き local-fixtures/ 追加を希望。

## [2026-09-08 受領] 黄色い名前設計（さつき発案）採用します・(2)は実現性測定から

MAIN へ。「在席＝黄色い名前」設計（両機種AI目視検証済み・黄色レンジ実測値）受領、ありがとうございます。**より特異的で(2)アンカーの土台**なので採用に動きます。ただし私の検証規律で**盲信せず**測定してから確定します。

- **linchpin**: 私が既に入れたエッジ密度版(1)で救っている **114640 BL（Android・folded・薄暗い・stack NaN）** で、**黄色名が発火するか**が鍵。薄暗い名前が R>150 に届かず未発火だと、黄色名"単独"だと 6→5 が再発する。→ 実測で確認し、**「席を絶対に落とさない」ため yellow-name を主・edge-density を fallback で OR** する方針（yellow単独で全occupied救えると実証できれば単独化も可）。全フレームで genuine empty が empty のまま・114640 BL と iOS folded が occupied を私が独立確認します。
- **(2)自己位置決め**: 実機根治の本命と認識。ただし大改修＋過学習回避のため、まず**実現性測定**（名前アンカー→スタック矩形のオフセットが全フレーム/両機種で低分散か）だけ実施。一貫すれば固定座標を置換でき **img.w>=2400 の脆さ＋機種座標ズレを根治**できる見込み。**実装はこの測定結果＋できればさつきの実機失敗スクショ入手後**に。
- Sonnetサブエージェントで測定＋(1)実装＋(2)実現性、私が両harness再測＋crop目視。結果は本欄へ。push/デプロイはしません。

## [2026-09-08 実装完了] 黄色名信号を採用（edge密度とOR）・(2)自己位置決めは不成立（commit c6815cf, 未push）

MAIN へ。さつき発案の黄色名設計を実装＋検証しました（私が両harness独立再測＋crop目視）。

- **(1)黄色名 detectYellowName**: `R>150,G>130,B<120,|R-G|<70,R-B>60` の黄色画素をスタック直下の帯(幅1.8x/高1.6x中央)で行カウント、≥4行で present。実測(GT22枚): **occupied 80/80検出・empty 30/30で黄色0**。**linchpin 114640 BL（折れ暗席・stack NaN）は黄色 "sak" を検出＝occupied維持を crop目視で確認**。
- **統合＝OR**: `occupied = stack読める || 黄色名 || edge密度`。**BEFORE==AFTER で両harness完全一致・回帰ゼロ**（本信号は堅牢性の純増でフィクスチャ数値は不変。6→5根治は既存 b2153df 済み）。黄色名を"単独主"にしなかった理由: **floor が薄い**（iPhoneコーナーfold席は帯1.8xでやっと検出・Android 114640 BR は1文字名 "k" で空席床すれすれ・iPhoneは2枚のみ）→ 「席を絶対落とさない」要件で edge密度(40xマージン)を保険に残す＝二重保証。tsc緑・ocr 137 tests緑。
- **★(2)自己位置決めは名前アンカー単独では不成立**（実現性測定, occupied80席・両機種）: 縦 dy=(stackBottom−nameTop)/nameH は一貫（mean−0.41, **sd0.12**）だが、横 dx（mean1.81, **sd2.05**, 範囲[−1.07,5.88]）とスケール stackW/nameH（**sd8.28**）が高分散。名前はスタック矩形より幅が可変・コーナー席で中心がずれるため、**名前から stack の中心x・幅は復元不可**。→ **名前アンカーでは未知解像度の根治にならない**。名前は y/スケールの sanity アンカー止まりが妥当。
- **結論（重要）**: 機種座標ズレ（img.w>=2400 の脆さ・さつきの実機5人）の**根治は名前アンカーでは無理**＝**実機の失敗スクショ（機種名＋フルサイズ）でのプロファイル較正が唯一の道**。引き続き入手を強く希望。それまで本丸(1)＝在席頑健化（NaN/暗名でも席維持）で「取りこぼし→人数減」は最大限止めています。
- 前回からの**未決2点**（要さつき/MAIN判断）: ①占有NaN席の下流＝仮値0で解かせない運用（Confirmで要入力必須化 or OCRで reject-with-issue）②実機スクショ。

## [2026-09-08 検証結果] BBアンカー: 幾何は完璧・localizationが壁（実装せず・commit無し）

MAIN へ共有（実装変更なし・ソース無変更）。さつき発案「BB表示は必ずあるので"BB"を位置/スケールのアンカーに」を測定検証。
- **幾何は剛体**: digitH/Hbb sd0.022・baselineΔ sd0.008・space/Hbb sd0.097。名前アンカー(dx sd2.05/scale sd8.28)より1-2桁タイト＝BBは数値と同一行で右端・スケールを精密固定できる（さつきの読み通り）。
- **壁＝BBのlocalization**: 部品分割＋字別B-NCCでの検出は53/76(iPhone 3/12)のみ。発光楕円の融合／隣席ベットの紫"BB"侵入／狭矩形で失敗。摂動テストでBBアンカー読みは平行移動不変(x全域~57-60% vs 固定矩形63%→1%)だが、クリーン時に固定矩形100%を超えられず68%に劣化→出荷不可・試作見送り。
- **結論**: 既存フィクスチャは全て正位置＝アンカーの利得(drift耐性)を実証できない。**BBアンカーの実装/検証には実機の失敗スクショが必須**。鍵は汚染耐性BB localizer("BB"バイグラムNCC帯走査＋数値隣接BB選択＋発光除去)。**実機スクショ入手後に着手予定**。それまで在席は既存3信号OR(黄色名/edge/stack)で頑健化済み。

## [2026-09-08 実装完了] 二段アンカー（黄色名→本命BB特定）でstack読みをNaN時フォールバック（commit 5d5337e, 未push）

MAIN へ。さつき発案の二段アンカーで前回の「どのBBか」壁を突破。**localizer の鍵はネーム基準の本命BB特定だった**。
- **前提データ確認**: 1席の切り抜きに "BB" が最大3つ（本命=ネーム真上/ポジションBBバッジ=左上/フェルトBB表示=左下）。**識別子2つが完全分離**: ①「直左に数字塊がある」＝本命40/40・バッジ/フェルト15/15は数字なし ②ネーム中心 dx/Nh 本命[-1.05,+4.59] vs バッジ[-8.93,-3.89] 非重複。黄色名検出78/78。
- **実装**: `seatPresence.detectYellowName` に名前 box{cx,top,bottom,h} 追加返却（.present不変）。`bbAmount.readAmountBbAnchored`(新規)＝周囲広め探索→BB候補列挙→直左に数字ある候補のみ→ネーム中心cxに最近を本命→Bの高さでスケール固定して桁NCC。`extract.ts` は **BB表示で現行が NaN の席のみ**本方式で復旧＝**クリーン席ビット不変・回帰ゼロ**。
- **検証(私が独立再測＋crop目視)**: Android/iPhone baseline完全一致(stack98.9%/verdict100%/iPhone全100%)。tsc緑・ocr142tests緑。**摂動スイープでドリフト不変(全dxで159/231)＝固定矩形は+0.4wで4/231に崩壊**＝ズレ耐性を synthetic に実証。
- **正直な限界**: 現行フィクスチャは全て正位置ゆえフォールバック未発火＝可視の数値変化なし(効果は潜在)。NaN時のみ発火なので「有限だが誤読」型ドリフト失敗は未カバー。**end-to-end実証＝実機失敗スクショが依然必須**。将来案: 固定/アンカー2リーダ不一致を低信頼フラグ化（有限誤読も確認画面に上げる・要MAIN Confirm連携）。

## [2026-09-08 完了] OCR抽出を純アンカー方式へ全面置換・カットオーバー（未push）

MAIN へ。さつき決定の純アンカー全面置換を、仕様全面改訂→本番非接続で構築→実証→カットオーバーの順で実施。**下流 runOcrPipeline/spotReconstruction/positionDerivation は不変で再利用**（境界維持）、変えたのは抽出（画像→RawReads）のみ。凍結interface `{ok,form?,issues,lowConfidenceFields}` 不変＝握手不要。

- 仕様: `docs/OCR_PHASE2.md` をアンカー・アーキテクチャで全面改訂（commit 5a15b64）。
- 実装: `src/upscaleNormalize.ts`（拡大正規化）/`seatEnum.ts`（合議で堅牢な席列挙・6→5再発ゼロ）/`extractAnchored.ts`＋`potAnchor.ts`＋`anchorAction.ts`（名前→直上BBでstack、"Pot :"でpot、Dボタン→リング位相でポジション、actionZoneで対象外棄却、保守的モード判定でchips過受理解消）。配線=`app/src/ocr/prefill.ts` を extractAnchored 一本に（固定座標はcrash安全網でthrow時のみ）。commit 5deaea0→f1a8f9b→d70733c。
- **検証（私が独立再測）**: 席列挙 playersLeft 28/28、共受理27枚の seat stack 102/102(±0.05)現行一致、全165枚でアプリ受理規則→both-accept27/both-reject133/実スクショOVER=0(1310救出のみ)/UNDER=0。**1310×536の劣化実機フレーム（固定座標では棄却/誤読）を ok=true・pot2.5・pl4 で読めるように**。tsc緑・ocr170/app74 tests緑。
- **残（正直）**: ①iOS action の cosmetic 後退（cardStateの機種別指標を選べず・**boardStateToFormに非伝播＝フォーム/求解に無影響**）②固定座標プロファイルは撤去せず温存（実機確認後）③1310 Chrisの白on ピンクのみNaN(lowConf)。
- **お願い**: 本番反映（手動 wrangler deploy）後、さつき実機で「通常スクショ＋あの1310型（縮小/加工されたもの）」を試して確認を。問題なければ固定座標を撤去して置換完了とします。push/デプロイは私からはしません（[[deploy-url]] ハザード厳守）。
