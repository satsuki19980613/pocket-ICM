# PLAN — MAIN セッション（OCR以外の仕様修正 ①②③④）

前提: `CONTRACT.md` の所有権・凍結ルールを厳守。凍結型（BoardForm 等）は変えない。
このラウンドの MAIN 課題はすべて MAIN 所有ファイル内で閉じる（OCR 内部・`prefillFromScreenshot` 戻り値に非依存）。

---

## 課題① ACTION TREE に各席スタックを表示

**症状**: 結果画面 ACTION TREE の各行、ポジションバッジと FOLD/PU の間が空白（さつき指摘の赤枠）。

**方針**: `SolveResultDto` はスタックを持たないが、`Result.tsx` が `state: BoardState`（`seats[].pos/stack`）を持つ。
`Result` → `ActionTree` に `pos→stack` のマップ（または `seats`）を prop で渡し、各 `.arow` に `12.4bb` を表示。

**触るファイル**（すべて MAIN 所有）
- `components/Result.tsx` … `ActionTree` に `stacks={Object.fromEntries(state.seats.map(s=>[s.pos,s.stack]))}` を渡す
- `components/ActionTree.tsx` … props に `stacks?: Record<string, number>` 追加、`.arow` 内に `<span className="arow-stack">{stacks[row.pos]}bb</span>`
- `styles.css` … `.arow-stack` の位置・色（hero 行は既存強調を流用、mono フォント）

**DoD**: 6人結果で全6席のスタックが赤枠位置に出る。hero 行が判別できる。tsc/テスト green。

---

## 課題② 表示名を廃止し handle 一本化

**決定（さつき）**: display_name の概念を UI から撤去し、識別子は **@handle（ユーザーID）一本**に。
**バックエンドは非改変**（signup Edge Function は display_name 必須のまま）→ サインアップ時に `display_name = handle` を送って通す。
既存データの display_name 列は残るが表示に使わない（マイグレーション不要）。

**触るファイル**（すべて MAIN 所有）
- `components/Auth.tsx` … サインアップから「表示名」欄・state・検証呼び出しを削除。
  `signUpWithInvite({ display_name: handle.trim().toLowerCase(), handle: 同, ... })` で送る。
- `auth/validate.ts`（+ `validate.test.ts`）… `validateSignup` から `display_name` を除去（呼び出し側 Auth に合わせる）。
- `components/feedShared.tsx` … `Avatar` の頭文字を `handle` 由来に。
- `components/Home.tsx` / `Thread.tsx` / `UserPub.tsx` … 著者表示を **@handle 一本**に（太字も @handle、display_name の行を撤去）。
- `components/Settings.tsx` … 「表示名」行と編集ロジック（editName 一式・`updateDisplayName`）を撤去。「ユーザー名(@handle)」行は残す（変更は従来通り準備中）。アバター頭文字も handle 由来に。
- `supabase/profile.ts` … `updateDisplayName` 不使用化（削除 or 残置だが未参照に）。`MyProfile` は display_name を残してよい（表示に使わないだけ）。
- `supabase/feed.ts` … クエリは display_name を select し続けてよい（非破壊）。表示側で使わないだけ。無理に外さない。

**注意**: `FeedAuthor` 型は `display_name` を持ち続けてよい（feed.ts・OCR非関与）。型を壊さず表示だけ handle に寄せる（差分最小）。

**DoD**: フィード/スレッド/他人公開/設定で識別子が @handle のみ。サインアップ画面に表示名欄が無い。tsc/テスト green。
サインアップ往復の実確認は**さつき実機**（Claude は mutation 不可）。

---

## 課題③ OCR 元画像の確認モーダル

**症状**: 写真を選んでOCR後、出力値と元画像を照合できず不便。

**方針**: 読み取った生 `File` を objectURL 化して保持し、**条件確認(Confirm)** と **修正(InputForm)** に
「元画像を確認」ボタン → 原寸モーダル。**OCR内部に非依存**（`prefillFromScreenshot` に渡す前の File を使う）。

**触るファイル**（すべて MAIN 所有）
- `App.tsx`
  - state 追加: `const [ocrImageUrl, setOcrImageUrl] = useState<string|null>(null)`
  - `onScreenshot(file)` 冒頭で `const url = URL.createObjectURL(file); setOcrImageUrl(prev=>{ if(prev) URL.revokeObjectURL(prev); return url; })`
  - **直接手入力**（IcmInput の `onManual`）や新規計算・リセット時に `setOcrImageUrl(null)`（あれば revoke）→ 写真経由でない時はボタンを出さない
  - `Confirm` と `InputForm` に `imageUrl={ocrImageUrl}` を渡す
- `components/ImageModal.tsx`（新規）… `props: { src: string; onClose: () => void }`。全画面オーバーレイ＋原寸画像（`overflow:auto` でスクロール/ピンチ）＋✕。Esc/背景クリックで閉じる。
- `components/Confirm.tsx` … `imageUrl?: string` prop 追加。あれば「元画像を確認」ボタン＋モーダル開閉 state。
- `components/InputForm.tsx` … 同上（修正画面でも確認できる）。
- `styles.css` … `.imgmodal`（オーバーレイ・原寸コンテナ・閉じるボタン）。

**DoD**: 写真経由で Confirm と修正画面の両方に「元画像を確認」が出て、原寸モーダルで読取値と照合できる。
直接手入力時はボタンが出ない。tsc/テスト green。実写真添付の通しはさつき実機。

---

## 課題④ スレッド添付画像のはみ出し

**症状**: スレッドのコメント添付画像が原寸で親を突き抜けて画面外へ（さつき2枚目）。

**原因**: `styles.css` `.cmt-img img` に `max-width` 指定が無い（親 `.cmt-img` は max-width:240px だが img が従わない）。

**修正**: `styles.css`（MAIN 所有）
```css
.cmt-img img { max-width: 100%; height: auto; }
```
（`.cmt-img` の max-width:240px はそのまま＝サムネ上限。原寸は本文の別リンク or ③方式の流用は不要）

**DoD**: スレッドの添付画像がカード幅に収まる。ブラウザ実機で確認。

---

## 実装順・検証・コミット

1. ④（CSS 1行）→ ①（ActionTree）→ ③（画像モーダル）→ ②（handle 一本化）
2. 各課題ごとに `tsc -b` + 該当テスト。まとめて `npm test`（app）。本番ビルド（`npm run build --workspace @oshihiki/app`）。
3. ブラウザ実機（MAIN は dev **:5173**）で ①③④ とフィード表示（②）を確認。スクショで証跡。
4. `git add` は **MAIN 所有ファイルのみ**。commit 直前に `from-ocr.md` を1読 → 一言 `from-main.md` に「commit する」。
5. さつき実機検証項目: ②サインアップ往復・③実写真添付の通し。push/デプロイはさつき指示後。

## 完了時
- `from-main.md` に「MAIN 完了・変更ファイル一覧・green 状況」を記録。
- 両セッション green を確認してから、さつきにマージ/デプロイ可否を確認。
