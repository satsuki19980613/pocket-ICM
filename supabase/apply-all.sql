-- Black Ops ICM — M1 バックエンド一括適用（0001〜0005 を結合）
-- 使い方: Supabase ダッシュボード → SQL Editor → New query に丸ごと貼って Run。
-- 何度流しても安全（create ... if not exists / or replace / on conflict）。

-- ========== 0001: スキーマ ==========
create extension if not exists pgcrypto with schema extensions;

create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  handle        text not null unique,
  display_name  text not null,
  avatar_url    text,
  is_admin      boolean not null default false,
  default_public boolean not null default false,
  created_at    timestamptz not null default now(),
  constraint profiles_handle_format check (handle ~ '^[a-z0-9_]{3,20}$'),
  constraint profiles_display_name_len check (char_length(display_name) between 1 and 40)
);

create table if not exists public.app_config (
  id              int primary key default 1,
  max_accounts    int not null default 25,
  invite_ttl_days int not null default 7,
  updated_at      timestamptz not null default now(),
  constraint app_config_singleton check (id = 1),
  constraint app_config_max_range check (max_accounts between 1 and 1000),
  constraint app_config_ttl_range check (invite_ttl_days between 1 and 365)
);

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

create table if not exists public.threads (
  id         uuid primary key default gen_random_uuid(),
  result_id  uuid not null references public.results(id) on delete cascade,
  author     uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists threads_created_idx on public.threads(created_at desc);

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

create table if not exists public.likes (
  thread_id  uuid not null references public.threads(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (thread_id, user_id)
);

-- ========== 0002: 関数 + トリガ ==========
create or replace function public.is_admin(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select is_admin from public.profiles where id = uid), false);
$$;

create or replace function public.claim_invite(p_code_hash text, p_user uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_max   int;
  v_count int;
  v_found boolean;
  v_status text;
begin
  perform pg_advisory_xact_lock(424242);

  select max_accounts into v_max from public.app_config where id = 1;
  if v_max is null then v_max := 25; end if;

  select count(*) into v_count from public.profiles;
  if v_count > v_max then
    return 'full';
  end if;

  update public.invite_codes
     set status = 'used', used_by = p_user, used_at = now()
   where code_hash = p_code_hash
     and status = 'unused'
     and expires_at > now();
  get diagnostics v_found = row_count;

  if v_found then
    return 'ok';
  end if;

  select status into v_status from public.invite_codes where code_hash = p_code_hash;
  if v_status is null then
    return 'invalid';
  elsif v_status <> 'unused' then
    return 'used';
  else
    return 'expired';
  end if;
end;
$$;

create or replace function public.protect_profile_privileged()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if current_setting('request.jwt.claims', true) is null
     or coalesce((current_setting('request.jwt.claims', true)::jsonb ->> 'role'), '') <> 'authenticated' then
    return new;
  end if;
  new.is_admin := old.is_admin;
  return new;
end;
$$;

drop trigger if exists protect_profile_privileged on public.profiles;
create trigger protect_profile_privileged
  before update on public.profiles
  for each row execute function public.protect_profile_privileged();

create or replace function public.touch_comment_updated_at()
returns trigger
language plpgsql
as $$
begin
  if new.body is distinct from old.body or new.image_url is distinct from old.image_url then
    new.updated_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists touch_comment_updated_at on public.comments;
create trigger touch_comment_updated_at
  before update on public.comments
  for each row execute function public.touch_comment_updated_at();

-- ========== 0003: RLS ==========
alter table public.profiles     enable row level security;
alter table public.app_config   enable row level security;
alter table public.invite_codes enable row level security;
alter table public.results      enable row level security;
alter table public.threads      enable row level security;
alter table public.comments     enable row level security;
alter table public.likes        enable row level security;

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated using (true);

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists app_config_admin_select on public.app_config;
create policy app_config_admin_select on public.app_config
  for select to authenticated using (public.is_admin(auth.uid()));

drop policy if exists app_config_admin_update on public.app_config;
create policy app_config_admin_update on public.app_config
  for update to authenticated
  using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

drop policy if exists invite_codes_admin_select on public.invite_codes;
create policy invite_codes_admin_select on public.invite_codes
  for select to authenticated using (public.is_admin(auth.uid()));

drop policy if exists results_select on public.results;
create policy results_select on public.results
  for select to authenticated using (owner = auth.uid() or is_public);

drop policy if exists results_insert on public.results;
create policy results_insert on public.results
  for insert to authenticated with check (owner = auth.uid());

drop policy if exists results_update on public.results;
create policy results_update on public.results
  for update to authenticated using (owner = auth.uid()) with check (owner = auth.uid());

drop policy if exists results_delete on public.results;
create policy results_delete on public.results
  for delete to authenticated using (owner = auth.uid());

drop policy if exists threads_select on public.threads;
create policy threads_select on public.threads
  for select to authenticated using (true);

drop policy if exists threads_insert on public.threads;
create policy threads_insert on public.threads
  for insert to authenticated
  with check (
    author = auth.uid()
    and exists (select 1 from public.results r where r.id = result_id and r.owner = auth.uid())
  );

drop policy if exists threads_delete on public.threads;
create policy threads_delete on public.threads
  for delete to authenticated using (author = auth.uid());

drop policy if exists comments_select on public.comments;
create policy comments_select on public.comments
  for select to authenticated using (true);

drop policy if exists comments_insert on public.comments;
create policy comments_insert on public.comments
  for insert to authenticated with check (author = auth.uid());

drop policy if exists comments_update on public.comments;
create policy comments_update on public.comments
  for update to authenticated using (author = auth.uid()) with check (author = auth.uid());

drop policy if exists comments_delete on public.comments;
create policy comments_delete on public.comments
  for delete to authenticated using (author = auth.uid());

drop policy if exists likes_select on public.likes;
create policy likes_select on public.likes
  for select to authenticated using (true);

drop policy if exists likes_insert on public.likes;
create policy likes_insert on public.likes
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists likes_delete on public.likes;
create policy likes_delete on public.likes
  for delete to authenticated using (user_id = auth.uid());

-- ========== 0004: Storage ==========
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152,
        array['image/png','image/jpeg','image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('thread-images', 'thread-images', true, 5242880,
        array['image/png','image/jpeg','image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "own avatar write" on storage.objects;
create policy "own avatar write" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own avatar update" on storage.objects;
create policy "own avatar update" on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own avatar delete" on storage.objects;
create policy "own avatar delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own thread-image write" on storage.objects;
create policy "own thread-image write" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'thread-images' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own thread-image update" on storage.objects;
create policy "own thread-image update" on storage.objects
  for update to authenticated
  using (bucket_id = 'thread-images' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own thread-image delete" on storage.objects;
create policy "own thread-image delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'thread-images' and (storage.foldername(name))[1] = auth.uid()::text);

-- ========== 0005: 初期データ ==========
insert into public.app_config (id, max_accounts, invite_ttl_days)
values (1, 25, 7)
on conflict (id) do nothing;
