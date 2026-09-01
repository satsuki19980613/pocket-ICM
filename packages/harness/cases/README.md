# 照合テストケース

このディレクトリの `*.json` が照合ハーネスの入力になる（`loadCasesFromDir`）。

## 現状（M1-1）

- **実 HRC 照合データはまだ無い**（さつきが Phase 0 で収集中）。
- ここに置いてある `synthetic-*.json` は**合成の暫定ケース**であり、`expected` の EV / EQ /
  レンジ値は**説明用の暫定値（placeholder）**。実ソルバー完成後の回帰基準としては使わない。
- 目的は「JSON を置けばハーネスが動く」ことの確認と、空実装ソルバーに対する
  「全件不一致」報告（M1-1 完了条件）の検証。

## HRC ケースを追加する手順（Phase 0 / 0-5）

1. HRC 無料版（`https://www.holdemresources.net/nashicm`）に
   ペイアウト `6 4 3 2 1 0`（実払い `+5..-1` のシフト形。SPEC §2.2）を入力。
2. 盤面（残り人数・各席スタック・ブラインド・アンティ方式と額）を入力し、
   PU / CA / OC の各枝のレンジ・頻度%・EQ を取得。
3. 本ディレクトリのスキーマ（`HarnessCaseSchema`）に合わせて JSON 化する。
   - `expected[].equity` と `expected[].ev` は**実払い pt 建て**で入れる
     （HRC の % は `1.00% = 0.16pt` で換算。SPEC §2.2）。
   - サイドポット発生ケースを必ず含める（§4.5）。
4. `exactEquity: true` は HU 等、厳密 equity で解ける局面にのみ付ける。
