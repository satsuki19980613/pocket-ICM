# SIT & GO（会員同士の対人トーナメント）設計契約

作業を分担するための **契約書**。ここに書いた型・規則・所有範囲は各担当が勝手に変えない
（変えたくなったら指揮役に戻す）。コードの契約は `packages/sng/src/protocol.ts` と
`packages/sng/src/types.ts` が正本で、この文書は「なぜそうか」と「どこが誰の担当か」を書く。

決定の経緯（さつき承認 2026-09-15）: 審判役は Cloudflare Durable Objects（無料プラン・SQLite クラス）、
ハンド行はサーバー（DO）が Supabase に書く、持ち時間 15 秒＋タイムバンク 30 秒、控えは無期限、
人数は 2〜6 人から作成者が選ぶ、上昇間隔 3/4/5 分、ゲームモード選択でプライズ pt を成績にする。

---

## 1. ルール（エンジンが守るもの）

| 項目 | 決め |
|---|---|
| 人数 | 作成者が 2/3/4/5/6 を選ぶ。**その人数が揃った瞬間に自動開始**（途中開始は無し） |
| 内部単位 | チップ。**レベル 1 の BB = 200 チップ**（ポーカーチェイスと同じ）。表示だけ現在レベルの BB で割る |
| 開始スタック | 75/100/150/200 BB ＝ 15,000 / 20,000 / 30,000 / 40,000 チップ |
| ブラインド表 | `@oshihiki/core` の 3 構造（通常 16 / ゆっくり 32 / もっとゆっくり 59）。SB=BB/2、アンティは表の値を**全員払い** |
| レベル | `level = min(表の長さ, floor((now − startedAt) / levelMs) + 1)` を**ハンド開始時に**評価（次のハンドから適用＝TDA） |
| 席順 | 開始時に参加者をシャッフルして席 0..n−1 に固定。ボタンの初期位置は乱択 |
| ボタン | **デッドボタン**。`bb = nextLive(prevBb)`／`sb = prevBb`（飛んでいれば dead・SB 無し）／`btn = prevSb`（飛んでいれば dead）。生存 2 人なら `btn = sb`（HU は SB がボタン・プリフロップ先手・ポストフロップ後手） |
| 手番 | プリフロップは `nextLive(bb)` から、ポストフロップは `nextLive(btn)` から（btn が dead 席でも席番号で数える） |
| 短いスタック | アンティ → ブラインドの順に `min(stack, 額)` を出す。足りなければその時点でオールイン |
| 最小レイズ | 直前の上乗せ幅以上。オールインが最小レイズに満たなければレイズ権は再開しない（標準） |
| ショーダウン | **全員表向き**（マック無し）。降ろして終わったハンドは誰の手札も公開しない |
| サイドポット | `@oshihiki/solver` の `distributePots`（拠出額レイヤ方式）。役は `eval7`。端数チップはボタンに近い席から |
| 脱落順位 | 同一ハンドで複数人が飛んだら**ハンド開始時スタックの多い方が上位**。最後の 1 人が 1 位 |
| pt | `gameModeSpec(config.mode).payouts.slice(0, players)[place − 1]`（core） |
| 持ち時間 | 1 アクション **15 秒**。切れたら**タイムバンク（1 試合 30 秒・補充なし）**を自動で消費。尽きたらチェックできればチェック、それ以外はフォールド（`auto=true`） |
| 自動処理の連続 | 自動アクションが **2 回連続**で `sitout`。sitout 中は手番が来た瞬間に自動処理（タイマー無し）。`sitin` で復帰 |
| 切断 | WebSocket が切れたら `connected=false`（表示用）。タイマーは通常どおり走る（短い切断を罰しない） |
| 離席 (`leave`) | 待機中＝席を離れる。進行中＝`left`（sitout と同じ扱いで戻れない）。**自分以外の生存者が全員 left なら残った人の勝ちで即終了** |
| 一時停止 | 生存者全員が sitout/left/切断 なら `paused`。**10 分**誰も戻らなければ `cancelled`（pt 無し・記録しない） |
| 募集の期限 | 待機中は **15 分**で埋まらなければ `cancelled`。作成者が待機中に抜けたら `cancelled` |
| ハンド間 | 結果表示のため **3 秒**空けて次のハンド |
| 1 人 1 部屋 | 待機中・進行中の部屋に居る人は作成も参加もできない（Lobby が判定） |

---

## 2. 構成

```
ブラウザ (React/Vite)                 Cloudflare Worker                       Supabase
  ├ /api/sng/rooms (HTTP, Bearer) ──▶ worker/index.ts ─▶ SngLobby (DO ×1)     auth/v1/user  ← JWT 検証
  ├ WS /api/sng/lobby ─────────────▶                     └ 部屋一覧・1人1部屋
  └ WS /api/sng/table/:roomId ─────▶                   SngTable (DO ×部屋)      rest/v1/sng_* ← service role で書く
                                                          └ エンジン (@oshihiki/sng) 
```

- **`packages/sng`**（新規・純 TS・依存は core / solver の一部 / zod）: ルール・状態機械・合法手・圧縮表現・
  プロトコル型。**ブラウザと Worker の両方**で動く。乱数は注入（テストは決定的に）。
- **`worker/sng/*`**: DO の殻。状態は毎回 `ctx.storage` に JSON で置く（**メモリに持たない**。Hibernation で消える）。
  タイマーは **Alarms 1 本**（`state` に「次に起こすべき時刻」を持ち、alarm で種類を判定）。
  `setInterval` / `setTimeout` での待機は禁止（無料枠の duration を食う）。
- **認証**: WS は接続後の**最初のメッセージ `{t:'auth', token}`** で Supabase の `GET /auth/v1/user`
  （`apikey: anon` + `Authorization: Bearer`）に問い合わせて userId を得る。5 秒以内に auth が来なければ閉じる。
  HTTP は `Authorization: Bearer` を同じ関数で検証。**Worker に JWT secret は置かない**。
- **書き込み**: DO が **service role キー**（Worker のシークレット `SUPABASE_SERVICE_ROLE_KEY`）で PostgREST に
  upsert。失敗したら `state.pendingWrites` に溜めて alarm で再送（最大 24 時間）。
- **環境変数**（ダッシュボード / `.dev.vars`）: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`。
  リポジトリには `.dev.vars.example` だけ置く。
- **状態配信は毎回フルスナップショット**（差分プロトコルは持たない）。卓の状態は数 KB・送信は無課金。
  クライアントは `seq` が小さいものを捨てるだけ。再接続も同じメッセージで復元できる。
  手札だけは `{t:'hole'}` で本人にだけ送る。
- **冪等化**: `act` は `handNo` と `actSeq`（その手番の通し番号）を必ず添える。ズレていれば `stale` で捨てる。
  クライアントは送信ボタンを同期ラッチ（`createStartLatch`）で 1 回に絞る（Slumbot の教訓）。
- **CPU 10ms/req**: ショーダウン評価は最大 6 人 × `eval7` で十分軽い。実装後に `wrangler dev` で計測して DEPLOY.md に書く。

---

## 3. DB（`supabase/migrations/0011_sng.sql`）

RLS は **select だけ**。insert/update/delete のポリシーは作らない（service role のみ書ける）。

```sql
sng_games      (id text pk '^sg_[0-9a-z]{8,24}$', host uuid, config jsonb, participants uuid[] not null,
                seats jsonb '[{seat, user_id, name}]' 席順,   -- 履歴で相手の表示名を出すため
                status text check in ('finished','cancelled'), started_at, ended_at, hands int, created_at)
                select: auth.uid() = any(participants)
sng_results    (game_id text fk, owner uuid fk profiles, seat int, place int, pt numeric, players int, mode text,
                ended_at timestamptz, primary key (game_id, owner))   select: owner = auth.uid()   index (owner, ended_at)
sng_hands      (game_id text fk, hand_no int, played_at timestamptz, participants uuid[] not null,
                level int, sb int, bb int, ante int,   -- 圧縮表現には入らない（decode の meta）
                hand text not null,  -- 圧縮表現 v1（§4）
                created_at timestamptz default now(), primary key (game_id, hand_no))
                select: auth.uid() = any(participants)   index gin(participants), index (created_at)
sng_hole_cards (game_id text, hand_no int, owner uuid, cards text(4), created_at default now(),
                primary key (game_id, hand_no, owner))   select: owner = auth.uid()   index (owner, created_at)
```

- `sng_games` は**終了時に 1 回**書く（cancelled も status 付きで書く。pt は付けない）。
- `sng_hands` はハンド終了ごとに 1 行。共有行に入れる手札は**ショーダウンで公開されたものだけ**。
  各自の手札は `sng_hole_cards` に本人行で入れる（他人の行は読めない）。
- 端末側は Slumbot と同じ B 方式: IndexedDB（`blackops-icm-sng`）が正、`created_at` カーソルで差分を引く。
- 見積り: 1 ハンド ≈ 250B（hands）＋ 6 × 80B（hole）。1 日 10 試合 × 100 ハンドで年 ≈ 270MB。**jsonb 禁止**。

---

## 4. ハンドの圧縮表現 v1（`packages/sng/src/encode.ts`）

1 ハンド = 1 行の文字列。`|` で項を区切る。先頭は版 `1`。

```
1|L<level>|B<btn>,<sbSeat|->,<bbSeat>|S<stack0>,<stack1>,...|C<seat>=<c1><c2>;...|D<flop><turn><river>|A<pre>/<flop>/<turn>/<river>|W<won0>,<won1>,...|E<seat>:<place>;...
```

- `S` はハンド開始時スタック（席順・飛んでいる席は `0`）。`W` は各席の獲得額（Σ = Σ 拠出額）。
- `C` はショーダウンで公開された手札だけ。`D` は到達したボードだけ（例 `AhKd2c` / `AhKd2cTs`）。
- `A` のトークン = `<seat><k>[<betTo>][!]`。`k`: `f` fold / `k` check / `c` call / `b` bet / `r` raise / `a` all-in。
  `betTo` はそのストリートの「〜まで」（チップ）。`!` は自動処理（時間切れ・sitout）。トークンは `.` 区切り。
  ストリートは `/` 区切りで到達分だけ。例: `A=3r600.4c.0f/4b800.3c/4k.3k/4a12000.3c`
- `E` はこのハンドで脱落した席と順位。
- `decodeHand` は `encodeHand` の完全な逆。往復テスト必須。

---

## 5. 画面（`packages/app`）

| 画面 | Screen | 深さ | 戻る先 |
|---|---|---|---|
| ハブ | `training` | 1 | ─ |
| SIT & GO ロビー（上半分＝作成パネル＋参加中の部屋、下半分＝募集中一覧を**パネル内スクロール**） | `sng` | 2 | training |
| 部屋（待機 → 卓 → 結果を 1 画面で切替） | `sngroom` | 3 | sng |
| STATS（上部で Slumbot / SIT & GO 切替。各タブに成績と HAND HISTORY ボタン） | `stats` | 2 | training |
| Slumbot ハンド履歴（既存） | `huhistory` | 3 | stats |
| SIT & GO ハンド履歴 | `snghistory` | 3 | stats |

- ハブのメニューは **Slumbot HU / SIT & GO / STATS**（AOF ドリルは Coming Soon のまま）。
  「あなたの通算」パネルは消す。`hustats` 画面は廃止して `stats` に統合。
- 卓は 2〜6 席を楕円に配置、自分は常に下。カードの見た目は `SlumbotTable` と同じクラス（`pt-card` 等）。
- ベット操作は Slumbot と同じプリセット＋スライダー＋ステッパー。`slumbot/sizes.ts` を
  「最小限の数値だけ受ける形」に一般化して共用する。
- スタック・ベット・ポットの表示は現在レベルの BB 換算を `formatBbDisplay`（core）で。
- 端末の戻るで部屋から抜けない: 進行中は `history.pushState` でダミーを積み `popstate` で退室確認。
- ハートビート `ping` 20 秒。`visibilitychange` 復帰と `close` で再接続（指数バックオフ 1→8 秒）。
- 自分の手番は残り秒数を表示（`deadline − (serverTime 補正済みの今)`）。

---

## 6. 担当と所有ファイル（重ねて編集しない）

| 担当 | 所有 |
|---|---|
| **A1 エンジン** | `packages/sng/src/engine/**`, `engine.ts`, `encode.ts`, `structure.ts`, `packages/core/src/blindStructure.ts`（表の移設）, `packages/ocr/src/blindLevels.ts`（core を再エクスポート）, `packages/solver/package.json`（`./evaluator` `./sidepot` のサブパス） |
| **A2 Worker/DB** | `worker/**`, `wrangler.jsonc`, `.dev.vars.example`, `.gitignore`, root `package.json`（devDeps・typecheck）, `supabase/migrations/0011_sng.sql`, `DEPLOY.md` |
| **A3a 対戦画面** | `packages/app/src/sng/{client,lobbyApi,useTable,betting}.ts`, `components/{SngLobby,SngRoom,SngTable}.tsx`, `src/sng-play.css`, `App.tsx`, `navModel.ts(+test)`, `TrainingHub.tsx`, `main.tsx`, `slumbot/sizes.ts`（一般化）, `vite.config.ts`（proxy） |
| **A3b 成績/履歴** | `packages/app/src/sng/{historyStore,historySync,stats,tenfour,useSngHands}.ts`, `supabase/{sngHands,sngResults}.ts`, `components/{StatsView,SngStatsView,SngHistoryView}.tsx`, `src/sng-stats.css` |
| **A4 文書** | `SPEC.md`, `docs/DATA_LEDGER.md` |

A3a が A3b の部品を使う契約: `StatsView({ onOpenHuHistory, onOpenSngHistory })` と `SngHistoryView()`
（どちらも default ではなく名前付き export）。A3b は `App.tsx` を触らない。
