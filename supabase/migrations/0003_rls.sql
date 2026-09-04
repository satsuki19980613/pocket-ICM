-- 0003: Row Level Security（RLS）
-- 原則（SPEC §8）:
--   - 自分の記録は本人のみ編集/削除、公開記録は全員閲覧。
--   - 管理データ（app_config / invite_codes）は管理者のみ閲覧、書き込みは Edge Function 経由。
--   - profiles/invite_codes への「挿入」は Edge Function（service_role）専用＝一般ポリシーを作らない。

alter table public.profiles     enable row level security;
alter table public.app_config   enable row level security;
alter table public.invite_codes enable row level security;
alter table public.results      enable row level security;
alter table public.threads      enable row level security;
alter table public.comments     enable row level security;
alter table public.likes        enable row level security;

-- ===== profiles =====
-- 閲覧: ログインユーザーは全員のプロフィールを見られる（SNS 面のため）。
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated using (true);

-- 更新: 本人のみ（is_admin の改竄はトリガ protect_profile_privileged で無効化）。
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
-- 挿入/削除ポリシーは作らない（挿入=signup Edge Function、削除=auth.users からの cascade）。

-- ===== app_config =====
-- 閲覧/更新とも管理者のみ（更新は set-max-accounts Edge Function 経由が正路）。
drop policy if exists app_config_admin_select on public.app_config;
create policy app_config_admin_select on public.app_config
  for select to authenticated using (public.is_admin(auth.uid()));

drop policy if exists app_config_admin_update on public.app_config;
create policy app_config_admin_update on public.app_config
  for update to authenticated
  using (public.is_admin(auth.uid())) with check (public.is_admin(auth.uid()));

-- ===== invite_codes =====
-- 閲覧のみ管理者に許可（マスク表示は UI 側。code_hash は機密だが管理者限定なので露出せずとも可）。
-- 発行/取消/消費はすべて Edge Function（service_role）。一般の insert/update/delete ポリシーは作らない。
drop policy if exists invite_codes_admin_select on public.invite_codes;
create policy invite_codes_admin_select on public.invite_codes
  for select to authenticated using (public.is_admin(auth.uid()));

-- ===== results =====
-- 閲覧: 本人 or 公開。
drop policy if exists results_select on public.results;
create policy results_select on public.results
  for select to authenticated using (owner = auth.uid() or is_public);

-- 挿入/更新/削除: 本人のみ。
drop policy if exists results_insert on public.results;
create policy results_insert on public.results
  for insert to authenticated with check (owner = auth.uid());

drop policy if exists results_update on public.results;
create policy results_update on public.results
  for update to authenticated using (owner = auth.uid()) with check (owner = auth.uid());

drop policy if exists results_delete on public.results;
create policy results_delete on public.results
  for delete to authenticated using (owner = auth.uid());

-- ===== threads =====
-- 閲覧: 全員（公開結果のフィード）。
drop policy if exists threads_select on public.threads;
create policy threads_select on public.threads
  for select to authenticated using (true);

-- 挿入: 本人が著者、かつ紐づく result は本人所有（公開は結果側で担保）。
drop policy if exists threads_insert on public.threads;
create policy threads_insert on public.threads
  for insert to authenticated
  with check (
    author = auth.uid()
    and exists (select 1 from public.results r where r.id = result_id and r.owner = auth.uid())
  );

-- 削除: 著者のみ。
drop policy if exists threads_delete on public.threads;
create policy threads_delete on public.threads
  for delete to authenticated using (author = auth.uid());

-- ===== comments =====
-- 閲覧: 全員。
drop policy if exists comments_select on public.comments;
create policy comments_select on public.comments
  for select to authenticated using (true);

-- 挿入: 本人が著者。
drop policy if exists comments_insert on public.comments;
create policy comments_insert on public.comments
  for insert to authenticated with check (author = auth.uid());

-- 更新: 自分のコメントのみ編集可（§5.1）。
drop policy if exists comments_update on public.comments;
create policy comments_update on public.comments
  for update to authenticated using (author = auth.uid()) with check (author = auth.uid());

-- 削除: 著者のみ。
drop policy if exists comments_delete on public.comments;
create policy comments_delete on public.comments
  for delete to authenticated using (author = auth.uid());

-- ===== likes =====
drop policy if exists likes_select on public.likes;
create policy likes_select on public.likes
  for select to authenticated using (true);

drop policy if exists likes_insert on public.likes;
create policy likes_insert on public.likes
  for insert to authenticated with check (user_id = auth.uid());

drop policy if exists likes_delete on public.likes;
create policy likes_delete on public.likes
  for delete to authenticated using (user_id = auth.uid());
