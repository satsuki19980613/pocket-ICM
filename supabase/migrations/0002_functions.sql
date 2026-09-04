-- 0002: サーバ側ロジック（SECURITY DEFINER 関数 + トリガ）
-- RLS の再帰を避けるため、権限判定は SECURITY DEFINER 関数に集約する。

-- ---------------------------------------------------------------------------
-- is_admin(uid): 指定ユーザーが管理者か。RLS ポリシーから呼ぶ。
--   SECURITY DEFINER で profiles を RLS 迂回で読む → profiles ポリシーの自己参照再帰を回避。
-- ---------------------------------------------------------------------------
create or replace function public.is_admin(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select is_admin from public.profiles where id = uid), false);
$$;

-- ---------------------------------------------------------------------------
-- claim_invite(code_hash, user): 招待キーを原子的に検証＋消費し、上限も強制。
--   前提: 呼び出し前に profiles 行が既に挿入済み（count に含まれる）。
--   戻り値: 'ok' | 'invalid' | 'expired' | 'used' | 'full'
--   'ok' 以外のとき、呼び出し側（Edge Function）は作成済み auth ユーザーを削除する。
--   advisory lock で全サインアップを直列化 → 同時実行でも上限を超えない。
-- ---------------------------------------------------------------------------
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
  perform pg_advisory_xact_lock(424242);  -- 全サインアップを直列化

  select max_accounts into v_max from public.app_config where id = 1;
  if v_max is null then v_max := 25; end if;

  select count(*) into v_count from public.profiles;  -- 既に挿入済みの新規ユーザーを含む
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

  -- 消費できなかった → 理由を切り分け
  select status into v_status from public.invite_codes where code_hash = p_code_hash;
  if v_status is null then
    return 'invalid';
  elsif v_status <> 'unused' then
    return 'used';       -- used / revoked
  else
    return 'expired';    -- unused だが期限切れ
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- トリガ: profiles の特権列（is_admin）をユーザー自身が書き換えられないようにする。
--   RLS の update ポリシーは行の所有だけを見るため、列レベル保護はトリガで担保。
--   service_role（Edge Function）やスーパーユーザー（SQL Editor）は素通し。
-- ---------------------------------------------------------------------------
create or replace function public.protect_profile_privileged()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- service_role / postgres からの操作は制限しない（初期付与・管理用）
  if current_setting('request.jwt.claims', true) is null
     or coalesce((current_setting('request.jwt.claims', true)::jsonb ->> 'role'), '') <> 'authenticated' then
    return new;
  end if;
  -- authenticated ユーザーは is_admin を変更できない（現在値に固定）
  new.is_admin := old.is_admin;
  return new;
end;
$$;

drop trigger if exists protect_profile_privileged on public.profiles;
create trigger protect_profile_privileged
  before update on public.profiles
  for each row execute function public.protect_profile_privileged();

-- ---------------------------------------------------------------------------
-- comments の updated_at を編集時に自動更新
-- ---------------------------------------------------------------------------
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
