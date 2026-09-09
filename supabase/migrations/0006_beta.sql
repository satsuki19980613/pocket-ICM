-- Black Ops ICM — βテスト仕上げ（WP-A1 サーバ基盤）
-- 0006: results 拡張 + images/ocr_reads 新設 + threads 拡張(通常投稿) + RLS + spot-images バケット
-- 対象: SPEC v3 §5.1/§5.7/§7.2/§8/§9/§12, BETA_PLAN.md WP-A1。
--
-- 適用: Supabase ダッシュボードの SQL Editor に 0001〜0005 適用後、本ファイルを1回で貼り付けて実行。
-- 冪等性: 何度実行しても壊れないよう、テーブルは `create table if not exists`、列は
--   `add column if not exists`、制約は pg_constraint を確認してから追加、ポリシーは
--   `drop policy if exists` → `create policy`、バケットは `on conflict (id) do update` とする。
-- 既存データ: `results` の既存行はそのまま有効（新列はすべて default 付き or null 可）。

-- =============================================================================
-- 1) images: 解析元スクショ（圧縮版）の参照。§7.2/§9.3。
--    spot-images バケット（private）に本体を置き、本テーブルでメタ情報と保持方針を管理する。
-- =============================================================================
create table if not exists public.images (
  id         uuid primary key default gen_random_uuid(),
  owner      uuid not null references public.profiles(id) on delete cascade,
  kind       text not null check (kind in ('spot')),
  bucket     text not null default 'spot-images',
  path       text not null unique,
  bytes      int,
  width      int,
  height     int,
  mime       text,
  sha256     text,
  created_at timestamptz not null default now(),
  expires_at timestamptz,             -- null = 無期限（OCR 失敗・低信頼画像。§7.2）
  protected  boolean not null default false  -- true = 自動削除しない（OCR 失敗画像）
);
create index if not exists images_owner_idx on public.images(owner, created_at desc);
-- purge-images が「削除対象（期限切れ・非保護）」を1クエリで拾うための部分インデックス。
create index if not exists images_expires_idx on public.images(expires_at)
  where expires_at is not null and not protected;

-- =============================================================================
-- 2) ocr_reads: OCR 改善データ基盤（成功・失敗を問わず1行）。§9.3/§12。
--    images を参照するため images の後、results を参照するため results(0001) 定義後に置く。
-- =============================================================================
create table if not exists public.ocr_reads (
  id             uuid primary key default gen_random_uuid(),
  owner          uuid not null references public.profiles(id) on delete cascade,
  image_id       uuid references public.images(id) on delete set null,  -- null 可（アップロード失敗時）。画像が保持期限で消えても読み取りログは残す
  result_id      uuid references public.results(id) on delete set null,
  ok             boolean not null,
  display_mode   text,
  street         text,
  issues         jsonb not null default '[]'::jsonb,
  issue_codes    jsonb not null default '[]'::jsonb,
  low_confidence jsonb not null default '[]'::jsonb,
  raw_reads      jsonb not null,       -- 固定スキーマの生読み取り全量（§12.2）
  state          jsonb,                -- 復元できた state（成功時）
  final_state    jsonb,                -- 実際に計算へ使われた最終 state（暗黙の正解ラベル）
  corrections    jsonb,                -- OCR 出力 → 最終入力 の差分
  app_version    text,
  ocr_version    text,
  device         jsonb,                -- { ua, dpr, w, h, aspect }
  created_at     timestamptz not null default now()
);
create index if not exists ocr_reads_ok_idx on public.ocr_reads(ok, created_at desc);
create index if not exists ocr_reads_display_mode_idx on public.ocr_reads(display_mode);
create index if not exists ocr_reads_device_aspect_idx on public.ocr_reads((device ->> 'aspect'));

-- =============================================================================
-- 3) results 拡張: 非同期計算・状態・冪等再送・画像/OCR参照。§5.7/§9.2。
--    image_id/ocr_read_id は上で作った images/ocr_reads を参照するためここに置く。
-- =============================================================================
alter table public.results
  add column if not exists status       text not null default 'done'
    check (status in ('solving','done','failed','aborted')),
  add column if not exists client_id    text,
  add column if not exists hero_hand    text,
  add column if not exists hero_pos     text,
  add column if not exists players_left int,
  add column if not exists verdict      text
    check (verdict is null or verdict in ('ALL_IN','FOLD')),
  add column if not exists hero_ev      numeric,
  add column if not exists solve_ms     int,
  add column if not exists error        text,
  add column if not exists image_id     uuid references public.images(id) on delete set null,
  add column if not exists ocr_read_id  uuid references public.ocr_reads(id) on delete set null,
  add column if not exists updated_at   timestamptz not null default now();

-- 一意制約（owner, client_id）: オフライン作成・再送の冪等キー。
-- client_id が null の行同士は標準の UNIQUE 制約どおり重複可（NULL は互いに等しいとみなされない）。
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'results_owner_client_id_key'
  ) then
    alter table public.results
      add constraint results_owner_client_id_key unique (owner, client_id);
  end if;
end $$;

create index if not exists results_owner_status_idx on public.results(owner, status);

-- updated_at の自動更新（comments の touch_comment_updated_at と同じ方針）。
create or replace function public.touch_result_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists touch_result_updated_at on public.results;
create trigger touch_result_updated_at
  before update on public.results
  for each row execute function public.touch_result_updated_at();

-- =============================================================================
-- 4) threads 拡張: 通常投稿（文字のみ／文字＋画像）。§5.1/§9.2。
-- =============================================================================
alter table public.threads
  add column if not exists kind       text not null default 'result'
    check (kind in ('result','post')),
  add column if not exists body       text
    check (body is null or char_length(body) <= 2000),
  add column if not exists image_url  text,
  add column if not exists updated_at timestamptz;

-- result_id を null 可へ（通常投稿は結果を持たない）。既に null 可なら no-op。
alter table public.threads alter column result_id drop not null;

-- 形の制約: result 投稿は result_id 必須／post 投稿は本文か画像の少なくとも一方が必要。
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'threads_shape'
  ) then
    alter table public.threads
      add constraint threads_shape
      check (
        (kind = 'result' and result_id is not null)
        or (kind = 'post' and (coalesce(body, '') <> '' or image_url is not null))
      );
  end if;
end $$;

-- updated_at の自動更新（本文/画像の編集時のみ更新。comments と同じ方針）。
create or replace function public.touch_thread_updated_at()
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

drop trigger if exists touch_thread_updated_at on public.threads;
create trigger touch_thread_updated_at
  before update on public.threads
  for each row execute function public.touch_thread_updated_at();

-- =============================================================================
-- 5) RLS: images / ocr_reads を有効化し、threads の insert/update ポリシーを更新。
-- =============================================================================
alter table public.images    enable row level security;
alter table public.ocr_reads enable row level security;

-- ----- threads -----
-- 挿入: 通常投稿（kind='post', result_id is null）を許可。結果投稿は従来どおり自分の result のみ。
drop policy if exists threads_insert on public.threads;
create policy threads_insert on public.threads
  for insert to authenticated
  with check (
    author = auth.uid()
    and (
      (kind = 'post' and result_id is null)
      or (
        kind = 'result'
        and result_id is not null
        and exists (select 1 from public.results r where r.id = result_id and r.owner = auth.uid())
      )
    )
  );

-- 更新（新設）: 著者のみ（通常投稿の本文編集用）。
drop policy if exists threads_update on public.threads;
create policy threads_update on public.threads
  for update to authenticated
  using (author = auth.uid())
  with check (author = auth.uid());

-- ----- images -----
drop policy if exists images_select on public.images;
create policy images_select on public.images
  for select to authenticated
  using (owner = auth.uid() or public.is_admin(auth.uid()));

drop policy if exists images_insert on public.images;
create policy images_insert on public.images
  for insert to authenticated
  with check (owner = auth.uid());

-- 更新: 本人のみ（OCR 失敗時に protected/expires_at を立て直すため）。
drop policy if exists images_update on public.images;
create policy images_update on public.images
  for update to authenticated
  using (owner = auth.uid()) with check (owner = auth.uid());

drop policy if exists images_delete on public.images;
create policy images_delete on public.images
  for delete to authenticated
  using (owner = auth.uid());

-- ----- ocr_reads -----
drop policy if exists ocr_reads_select on public.ocr_reads;
create policy ocr_reads_select on public.ocr_reads
  for select to authenticated
  using (owner = auth.uid() or public.is_admin(auth.uid()));

drop policy if exists ocr_reads_insert on public.ocr_reads;
create policy ocr_reads_insert on public.ocr_reads
  for insert to authenticated
  with check (owner = auth.uid());

-- 更新: 本人のみ（final_state/corrections の後追い書込み用）。
drop policy if exists ocr_reads_update on public.ocr_reads;
create policy ocr_reads_update on public.ocr_reads
  for update to authenticated
  using (owner = auth.uid())
  with check (owner = auth.uid());

-- =============================================================================
-- 6) Storage: spot-images バケット（private・1MB上限）＋ポリシー。§7.2/§8。
--    公開 URL は使わない（表示は署名 URL）。select は本人 or 管理者に限定。
-- =============================================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('spot-images', 'spot-images', false, 1048576,
        array['image/png','image/jpeg','image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "own spot-image write" on storage.objects;
create policy "own spot-image write" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'spot-images' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own spot-image update" on storage.objects;
create policy "own spot-image update" on storage.objects
  for update to authenticated
  using (bucket_id = 'spot-images' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "own spot-image delete" on storage.objects;
create policy "own spot-image delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'spot-images' and (storage.foldername(name))[1] = auth.uid()::text);

-- 閲覧: 自分の <uid>/ 配下 or 管理者（private バケットなので明示ポリシーが無いと誰も読めない）。
drop policy if exists "spot-image read own or admin" on storage.objects;
create policy "spot-image read own or admin" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'spot-images'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin(auth.uid()))
  );
