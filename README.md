# 押し引きノート（仮称）

ポーカーチェイス クラブマッチ（6人SNG・固定ペイアウト +5/+3/+2/+1/0/−1pt）向けの
**push/fold ICM 復習ツール**。スクショまたは手入力で盤面を入力し、Nash均衡解とEV差を表示する。

- **リアルタイムアシスタンス（RTA）は実装しない。** プレイ中の支援は一切提供しない。
- バックエンドなし。端末ローカル完結の PWA として配布予定（本リポジトリは Solver コアから着手）。
- 仕様の正: [`SPEC.md`](SPEC.md) / 進め方の正: [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md)

## 現在の状態: 第3マイルストーン（M3）

Solver コア。Phase 1 の求解本体まで（3-way まで実装）。

| 項目 | 内容 | 状態 |
|---|---|---|
| M1-0 | データ契約（盤面状態/解JSON）の型・検証、CI | ✅ |
| M1-1 | 照合ハーネス骨組み（項目別基準・差分レポート・合成ケース） | ✅ |
| M1-2 | ICM equity（Malmuth-Harville, 実払い直接, 720通り厳密） | ✅ |
| M1-3 | HU 169×169 all-in equity テーブル（厳密全列挙・成果物同梱） | ✅ |
| M2-1 | レンジ記法パーサ（§4.6） | ✅ |
| M2-2〜2-4 | HU push/fold Nash（FP）+ exploitability + EV/EQ | ✅ |
| M2-5 / 1-4 | マルチウェイ着順分布 MC + コスト実測 | ✅ |
| M3 / 1-5 | サイドポット分配 + ショーダウン→終局スタック→ICM の計算パス | ✅ |
| M3 / 1-8 | 3〜6人 逐次 push/fold（PU/CA/OC）+ FP + exploitability + 収束不十分フラグ | ✅ 3-way（4〜6人は続くステップ） |

スコープ外（今回やらない）: 4〜6人求解、OCR、UI。HRC 実照合値は Phase 0（さつき収集）待ち。

## 構成（npm workspaces モノレポ / TypeScript）

```
packages/
  core/     データ契約: 169ハンドクラス, ポジション導出, 解キー正規化,
            盤面状態(§3.1)/解(§3.2) の zod スキーマと検証
  solver/   MH-ICM, 7枚ハンド評価器, HU equity（厳密全列挙）,
            169×169 テーブル生成・同梱・読み込み, HU push/fold Nash,
            マルチウェイ着順分布 MC, サイドポット分配, ショーダウン→ICM,
            3-way 逐次 push/fold ソルバー（FP + exploitability）
  harness/  HRC 照合ハーネス: JSONケース読込, 項目別合格基準(§4.3),
            境界ハンド明示の差分レポート
```

技術スタック: TypeScript / Vitest / zod / GitHub Actions（すべて無償）。

## コマンド

```bash
npm install
npm test          # 全パッケージのテスト（Vitest）
npm run typecheck # 型チェック（tsc -b + scripts）
npm run gen:hu-equity   # HU 169×169 equity テーブルを再生成（並列・数分）
```

## 検証（二本立て / IMPLEMENTATION_PLAN §4）

1. **HRC照合**: `packages/harness/cases/*.json` に HRC 参照値を置いて照合。
   実データ収集は Phase 0（さつき作業）。現状は合成の暫定ケースのみ。
2. **exploitability 自己検証**: 求解実装（後続マイルストーン）に対して閾値を課す。

合格基準は項目別（EQ絶対誤差 / レンジは |EV|<δ の境界ハンド許容 / 頻度±0.5% /
exploitability 閾値）。SPEC §2.2 に基づき % は基準プール（既定16）で pt へ換算。

## 成果物: HU equity テーブル

`packages/solver/artifacts/hu-equity-169.{f32.bin,meta.json}`（約114KB, Float32, 行優先）。
これは**ゲームアセットではなく計算による派生データ**なのでリポジトリに含める（SPEC §10 の
「ゲーム内アセット画像を含めない」規定には抵触しない）。カードテンプレート等の画像アセットは
将来も含めず、初回セットアップ時に利用者スクショから生成する方針。

厳密性の担保: hero を各クラスの単一代表コンボに固定 + villain コンボを suit 同型で軌道化 +
HU 零和性で上三角のみ計算。いずれも近似なし（テストで全コンボ平均との一致を確認）。

## 免責・方針

- ICM は Malmuth-Harville（着順分布の近似モデル）。検証は「真値一致」ではなく「HRC同等性」。
- 将来ブラインド上昇（FGS）は考慮しない。
- 他プレイヤー名は端末ローカル保存のみ。公開用サンプルではマスクする。
