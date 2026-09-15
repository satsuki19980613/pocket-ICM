/**
 * Worker 全体で共有する Env。`worker/index.ts` から re-export する（担当 A2 所有・worker/**）。
 *
 * SIT & GO 用の 3 つのシークレット（SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY）は
 * `.dev.vars`（ローカル）またはダッシュボードの Secret（本番）から注入される。リポジトリには
 * `.dev.vars.example` だけを置く。詳細は DEPLOY.md「SIT & GO」節。
 */

export interface Env {
  /** wrangler.jsonc の assets.binding。ビルド成果物（packages/app/dist）。 */
  readonly ASSETS: { fetch(request: Request): Promise<Response> };
  /** SIT & GO: ロビー（単一インスタンス "lobby"）。部屋一覧・1人1部屋の判定。 */
  readonly SNG_LOBBY: DurableObjectNamespace;
  /** SIT & GO: 卓（部屋ごとに 1 インスタンス）。ゲーム状態そのもの。 */
  readonly SNG_TABLE: DurableObjectNamespace;
  /** Supabase プロジェクト URL。 */
  readonly SUPABASE_URL: string;
  /** Supabase anon key（認証確認・本人権限での profiles 読み取りに使う）。 */
  readonly SUPABASE_ANON_KEY: string;
  /** Supabase service role key（SIT & GO のハンド・結果の書き込み専用。認証には使わない）。 */
  readonly SUPABASE_SERVICE_ROLE_KEY: string;
}
