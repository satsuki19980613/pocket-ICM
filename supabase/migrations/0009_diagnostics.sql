-- 0009: 管理者用の診断ログ（2026-09-11 さつき依頼「最近誰か計算を回したか・未報告のサイレントエラーを確かめたい」）
--
-- 1) client_errors: アプリで起きた想定外のエラー（画面の描画失敗・処理の例外・裏で握りつぶしていたサーバへの
--    保存失敗）の記録。書けるのはメンバー本人の行だけ、読めるのは管理者だけ。更新・削除は誰もできない
--    （アカウント削除の連鎖削除を除く）。1人1時間30件まで（超えた分は黙って捨てる）・90日より古い行は
--    挿入のついでに片付ける。
-- 2) 管理者専用の読み出し関数 admin_diag_summary / admin_list_runs / admin_list_ocr_reads /
--    admin_list_client_errors。中で is_admin を確かめ、管理者以外（メンバー・招待外・未ログイン）は 42501 で拒否する。
--    results の閲覧ポリシー（本人か公開のみ）は広げない。広げると管理者の「記録」タブやフィードの取得に
--    他人の非公開記録が混ざりうるため、全員分はこの専用の関数からだけ見る。
--    スクショは既存の Storage ポリシー（spot-images は本人か管理者だけ読める）で署名 URL を発行する。
--
-- 適用: Supabase ダッシュボードの SQL Editor に貼り付けて1回実行。冪等（何度実行しても壊れない）。
-- 順番: アプリより先でも後でもよい。この SQL が無い間は、診断ログ画面が「サーバの準備がまだです」になり、
--       エラーの送信は黙って失敗するだけ（利用者の操作には影響しない）。

-- =============================================================================
-- 1) client_errors
-- =============================================================================
create table if not exists public.client_errors (
  id          uuid primary key default gen_random_uuid(),
  owner       uuid not null references public.profiles(id) on delete cascade,
  -- error=実行時エラー / rejection=非同期処理の失敗 / render=画面の描画失敗 / ocr=OCR の例外 /
  -- sync=サーバへの保存失敗（画像・読み取りログ・計算記録）
  kind        text not null check (kind in ('error', 'rejection', 'render', 'ocr', 'sync')),
  message     text not null check (char_length(message) between 1 and 500),
  detail      text check (detail is null or char_length(detail) <= 4000),   -- スタック等
  screen      text check (screen is null or char_length(screen) <= 32),
  app_version text check (app_version is null or char_length(app_version) <= 64),
  device      jsonb check (device is null or (jsonb_typeof(device) = 'object' and octet_length(device::text) <= 1000)),
  created_at  timestamptz not null default now()
);
create index if not exists client_errors_created_idx on public.client_errors(created_at desc);
create index if not exists client_errors_owner_idx on public.client_errors(owner, created_at desc);

alter table public.client_errors enable row level security;

-- 書き込み: メンバー本人の行だけ。
drop policy if exists client_errors_insert on public.client_errors;
create policy client_errors_insert on public.client_errors
  for insert to authenticated
  with check (owner = auth.uid() and (select public.is_member(auth.uid())));

-- 閲覧: 管理者だけ（送った本人も読めない）。
drop policy if exists client_errors_select on public.client_errors;
create policy client_errors_select on public.client_errors
  for select to authenticated
  using ((select public.is_admin(auth.uid())));

-- 更新・削除のポリシーは作らない（＝誰もできない）。権限そのものも外しておく。
revoke all on public.client_errors from anon;
revoke update, delete, truncate, references, trigger on public.client_errors from authenticated;
grant select, insert on public.client_errors to authenticated;

-- 作成日時はサーバの時刻・1人1時間30件まで・90日より古い行の片付け。
-- security definer: 件数の確認と片付けは RLS（閲覧は管理者だけ）を越えて行う必要がある。
create or replace function public.client_errors_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recent int;
begin
  new.created_at := now();
  select count(*) into v_recent
    from public.client_errors
   where owner = new.owner and created_at > now() - interval '1 hour';
  if v_recent >= 30 then
    -- 暴走した端末で表が埋まらないように、超えた分は黙って捨てる（エラーにすると送信側がまた送る）。
    return null;
  end if;
  delete from public.client_errors where created_at < now() - interval '90 days';
  return new;
end;
$$;
revoke all on function public.client_errors_before_insert() from public, anon, authenticated;

drop trigger if exists client_errors_before_insert on public.client_errors;
create trigger client_errors_before_insert
  before insert on public.client_errors
  for each row execute function public.client_errors_before_insert();

-- =============================================================================
-- 2) 管理者専用の読み出し関数
-- =============================================================================

-- OCR の読み取りから利用者が1か所でも直したか（corrections は ocrLog.ts の diffStates の形:
-- { seats: [...], playersLeft?, heroPos?, heroHand?, blinds?, ante? }）。アプリ側の hasCorrections と同じ判定。
-- CASE は上から順に評価されるので、配列でないものに jsonb_array_length を当てることはない。
create or replace function public.diag_has_corrections(c jsonb)
returns boolean
language sql
immutable
set search_path = public
as $$
  select case
    when c is null or jsonb_typeof(c) <> 'object' then false
    when (c - 'seats') <> '{}'::jsonb then true
    when jsonb_typeof(c -> 'seats') <> 'array' then false
    else jsonb_array_length(c -> 'seats') > 0
  end;
$$;
revoke all on function public.diag_has_corrections(jsonb) from public, anon, authenticated;

-- 直近の件数と「最後に計算した人・時刻」。止まったまま（solving のまま10分以上）は期間を問わず数える。
drop function if exists public.admin_diag_summary(timestamptz);
create function public.admin_diag_summary(p_since timestamptz)
returns table (
  runs_total      int,
  runs_failed     int,
  runs_aborted    int,
  runs_stuck      int,
  last_run_at     timestamptz,
  last_run_handle text,
  ocr_total       int,
  ocr_failed      int,
  ocr_corrected   int,
  errors_total    int
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not coalesce(public.is_admin(auth.uid()), false) then
    raise exception 'admin only' using errcode = '42501';
  end if;
  return query
  select
    (select count(*)::int from public.results r where r.created_at >= p_since),
    (select count(*)::int from public.results r where r.created_at >= p_since and r.status = 'failed'),
    (select count(*)::int from public.results r where r.created_at >= p_since and r.status = 'aborted'),
    (select count(*)::int from public.results r
      where r.status = 'solving' and r.updated_at < now() - interval '10 minutes'),
    (select r.created_at from public.results r order by r.created_at desc limit 1),
    (select p.handle from public.results r join public.profiles p on p.id = r.owner
      order by r.created_at desc limit 1),
    (select count(*)::int from public.ocr_reads o where o.created_at >= p_since),
    (select count(*)::int from public.ocr_reads o where o.created_at >= p_since and not o.ok),
    (select count(*)::int from public.ocr_reads o
      where o.created_at >= p_since and public.diag_has_corrections(o.corrections)),
    (select count(*)::int from public.client_errors e where e.created_at >= p_since);
end;
$$;
revoke all on function public.admin_diag_summary(timestamptz) from public, anon;
grant execute on function public.admin_diag_summary(timestamptz) to authenticated;

-- 全員の計算の記録（非公開を含む・新しい順）。p_problems_only=true は
-- 失敗・中断・止まったまま・OCR を直したもの（＝黙って直された読み違い）だけ。
drop function if exists public.admin_list_runs(int, timestamptz, boolean);
create function public.admin_list_runs(
  p_limit int default 30,
  p_before timestamptz default null,
  p_problems_only boolean default false
)
returns table (
  id           uuid,
  created_at   timestamptz,
  updated_at   timestamptz,
  owner_handle text,
  owner_name   text,
  status       text,
  error        text,
  solve_ms     int,
  players_left int,
  hero_pos     text,
  hero_hand    text,
  verdict      text,
  hero_action  text,
  is_public    boolean,
  image_path   text,
  ocr_ok       boolean,
  ocr_issues   jsonb,
  corrections  jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not coalesce(public.is_admin(auth.uid()), false) then
    raise exception 'admin only' using errcode = '42501';
  end if;
  return query
  select r.id, r.created_at, r.updated_at, p.handle, p.display_name,
         r.status, r.error, r.solve_ms, r.players_left, r.hero_pos, r.hero_hand,
         r.verdict, r.hero_action, r.is_public,
         i.path, o.ok, o.issues, o.corrections
    from public.results r
    join public.profiles p on p.id = r.owner
    left join public.images i on i.id = r.image_id
    left join public.ocr_reads o on o.id = r.ocr_read_id
   where (p_before is null or r.created_at < p_before)
     and (
       not coalesce(p_problems_only, false)
       or r.status in ('failed', 'aborted')
       or (r.status = 'solving' and r.updated_at < now() - interval '10 minutes')
       or public.diag_has_corrections(o.corrections)
     )
   order by r.created_at desc
   limit least(greatest(coalesce(p_limit, 30), 1), 200);
end;
$$;
revoke all on function public.admin_list_runs(int, timestamptz, boolean) from public, anon;
grant execute on function public.admin_list_runs(int, timestamptz, boolean) to authenticated;

-- 全員の OCR 読み取り（新しい順）。p_problems_only=true は読めなかったもの・利用者が直したものだけ。
-- raw_reads（生読み取り全量）は重いので返さない（詳しい解析は pullFailures.ts で行う）。
drop function if exists public.admin_list_ocr_reads(int, timestamptz, boolean);
create function public.admin_list_ocr_reads(
  p_limit int default 30,
  p_before timestamptz default null,
  p_problems_only boolean default false
)
returns table (
  id             uuid,
  created_at     timestamptz,
  owner_handle   text,
  owner_name     text,
  ok             boolean,
  display_mode   text,
  street         text,
  issues         jsonb,
  issue_codes    jsonb,
  low_confidence jsonb,
  corrections    jsonb,
  result_id      uuid,
  image_path     text,
  device         jsonb,
  app_version    text,
  ocr_version    text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not coalesce(public.is_admin(auth.uid()), false) then
    raise exception 'admin only' using errcode = '42501';
  end if;
  return query
  select o.id, o.created_at, p.handle, p.display_name,
         o.ok, o.display_mode, o.street, o.issues, o.issue_codes, o.low_confidence, o.corrections,
         o.result_id, i.path, o.device, o.app_version, o.ocr_version
    from public.ocr_reads o
    join public.profiles p on p.id = o.owner
    left join public.images i on i.id = o.image_id
   where (p_before is null or o.created_at < p_before)
     and (not coalesce(p_problems_only, false) or not o.ok or public.diag_has_corrections(o.corrections))
   order by o.created_at desc
   limit least(greatest(coalesce(p_limit, 30), 1), 200);
end;
$$;
revoke all on function public.admin_list_ocr_reads(int, timestamptz, boolean) from public, anon;
grant execute on function public.admin_list_ocr_reads(int, timestamptz, boolean) to authenticated;

-- アプリのエラー（新しい順）。
drop function if exists public.admin_list_client_errors(int, timestamptz);
create function public.admin_list_client_errors(
  p_limit int default 30,
  p_before timestamptz default null
)
returns table (
  id           uuid,
  created_at   timestamptz,
  owner_handle text,
  owner_name   text,
  kind         text,
  message      text,
  detail       text,
  screen       text,
  app_version  text,
  device       jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not coalesce(public.is_admin(auth.uid()), false) then
    raise exception 'admin only' using errcode = '42501';
  end if;
  return query
  select e.id, e.created_at, p.handle, p.display_name,
         e.kind, e.message, e.detail, e.screen, e.app_version, e.device
    from public.client_errors e
    join public.profiles p on p.id = e.owner
   where (p_before is null or e.created_at < p_before)
   order by e.created_at desc
   limit least(greatest(coalesce(p_limit, 30), 1), 200);
end;
$$;
revoke all on function public.admin_list_client_errors(int, timestamptz) from public, anon;
grant execute on function public.admin_list_client_errors(int, timestamptz) to authenticated;
