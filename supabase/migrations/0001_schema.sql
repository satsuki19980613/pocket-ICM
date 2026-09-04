-- Black Ops ICM — M1 バックエンド基盤
-- 0001: 拡張 + スキーマ（テーブル定義）
-- 適用: Supabase ダッシュボードの SQL Editor に貼り付けて実行（0001→0005 の順）。
--
-- 設計方針（SPEC §2/§3/§4/§8/§9）:
--   - 認証は Supabase Auth（auth.users）。profiles が公開プロフィール。
--   - 招待キーは「ハッシュのみ保存・使い捨て・期限付き」（生キーは DB に置かない）。
--   - 上限/招待/管理操作は必ずサーバ側（RLS + Edge Function で二重強制）。
--   - 課金ゼロ: 追加サービスなし。Postgres 標準機能のみ。

-- pgcrypto: gen_random_uuid()（Supabase では既定で有効なことが多いが明示）
create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- profiles: 公開プロフィール（auth.users と 1:1）
-- ---------------------------------------------------------------------------
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  handle        text not null unique,
  display_name  text not null,
  avatar_url    text,
  is_admin      boolean not null default false,
  default_public boolean not null default false,  -- §5.5 公開既定（初期オフ）
  created_at    timestamptz not null default now(),
  -- handle は英小文字/数字/アンダースコア 3〜20 文字（synthetic email の local-part にも使う）
  constraint profiles_handle_format check (handle ~ '^[a-z0-9_]{3,20}$'),
  constraint profiles_display_name_len check (char_length(display_name) between 1 and 40)
);

-- ---------------------------------------------------------------------------
-- app_config: 運用値（単一行・id は必ず 1）
-- ---------------------------------------------------------------------------
create table if not exists public.app_config (
  id              int primary key default 1,
  max_accounts    int not null default 25,
  invite_ttl_days int not null default 7,
  updated_at      timestamptz not null default now(),
  constraint app_config_singleton check (id = 1),
  constraint app_config_max_range check (max_accounts between 1 and 1000),
  constraint app_config_ttl_range check (invite_ttl_days between 1 and 365)
);

-- ---------------------------------------------------------------------------
-- invite_codes: 招待キー（ハッシュのみ・使い捨て・期限付き）
--   code_hash : SHA-256(正規化キー) の hex（生キーは保存しない）
--   ref       : 非機密の識別子（管理一覧で未使用キーを見分ける用・4hex）
--   status    : unused / used / revoked（expired は expires_at で導出）
-- ---------------------------------------------------------------------------
create table if not exists public.invite_codes (
  id          uuid primary key default gen_random_uuid(),
  code_hash   text not null unique,
  ref         text not null,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  status      text not null default 'unused',
  used_by     uuid references public.profiles(id) on delete set null,
  used_at     timestamptz,
  constraint invite_status_check check (status in ('unused','used','revoked'))
);
create index if not exists invite_codes_status_idx on public.invite_codes(status);
create index if not exists invite_codes_created_idx on public.invite_codes(created_at desc);

-- ---------------------------------------------------------------------------
-- results: 計算結果（スポット条件＋解メタ）。§5.3/§5.4
--   spot     : 入力（BoardState 等）を JSON で保持
--   solution : 表示に必要な解メタ（判定/EV/レンジ要約等）を JSON で保持
-- ---------------------------------------------------------------------------
create table if not exists public.results (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null references public.profiles(id) on delete cascade,
  spot        jsonb not null,
  solution    jsonb,
  hero_action text,
  ev_loss     numeric,
  is_public   boolean not null default false,
  created_at  timestamptz not null default now(),
  constraint results_hero_action_check check (hero_action is null or hero_action in ('ALL_IN','FOLD'))
);
create index if not exists results_owner_idx on public.results(owner, created_at desc);
create index if not exists results_public_idx on public.results(created_at desc) where is_public;

-- ---------------------------------------------------------------------------
-- threads: 公開スレッド（公開された result への投稿）。§5.1
-- ---------------------------------------------------------------------------
create table if not exists public.threads (
  id         uuid primary key default gen_random_uuid(),
  result_id  uuid not null references public.results(id) on delete cascade,
  author     uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists threads_created_idx on public.threads(created_at desc);

-- ---------------------------------------------------------------------------
-- comments: スレッドへの投稿/返信（画像添付可）。§5.1
-- ---------------------------------------------------------------------------
create table if not exists public.comments (
  id         uuid primary key default gen_random_uuid(),
  thread_id  uuid not null references public.threads(id) on delete cascade,
  author     uuid not null references public.profiles(id) on delete cascade,
  body       text,
  image_url  text,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  constraint comments_nonempty check (coalesce(body,'') <> '' or image_url is not null),
  constraint comments_body_len check (body is null or char_length(body) <= 2000)
);
create index if not exists comments_thread_idx on public.comments(thread_id, created_at);

-- ---------------------------------------------------------------------------
-- likes: スレッドへの♡（1人1件）。§5.1
-- ---------------------------------------------------------------------------
create table if not exists public.likes (
  thread_id  uuid not null references public.threads(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (thread_id, user_id)
);
